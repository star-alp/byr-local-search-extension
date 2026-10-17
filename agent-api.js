/* 邮人全搜 Agent 协议第一版：供本机浏览器调试连接调用，提供上下文、预览、搜索控制和增量结果。 */

globalThis.ByrAgent = (() => {
  const GLOBAL_NAME = "__BYR_LOCAL_SEARCH_AGENT_V1__";
  const SEARCH_FIELDS = ["query", "mode", "scope", "boards", "boardPages", "threadPages", "timeRange", "dateFrom", "dateTo", "persist", "confirm"];
  const URL_FIELDS = ["agent", "api", "action", "sourceTabId", "pageSize", "stream", "bridge", "bridgePort", "bridgeToken", ...SEARCH_FIELDS];

  function invalid(message, code = "INVALID_ARGUMENT") {
    throw Object.assign(new Error(message), { code });
  }

  function object(value, fields) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("参数必须是对象");
    for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`不支持的参数：${key}`);
  }

  function integer(value, max) {
    if (!Number.isInteger(value) || value < 1 || value > max) invalid(`数值必须是 1～${max} 的整数`);
    return value;
  }

  function normalizeOptions(input, search = true) {
    object(input, SEARCH_FIELDS);
    const options = { ...input, persist: input.persist ?? false, confirm: input.confirm ?? false };
    if (search && typeof options.query !== "string") invalid("请提供搜索关键词");
    if (options.query !== undefined) {
      if (typeof options.query !== "string" || !options.query.trim()) invalid("搜索关键词不能为空");
      options.query = options.query.trim();
    }
    if (search) options.mode ??= "online";
    if (options.mode !== undefined && !["online", "local"].includes(options.mode)) invalid("搜索模式只能是 online 或 local");
    if (typeof options.persist !== "boolean" || typeof options.confirm !== "boolean") invalid("persist 和 confirm 必须是布尔值");
    if (options.scope !== undefined && (typeof options.scope !== "string" || !/^(?:last-used|recommended|saved:.+)$/u.test(options.scope))) invalid("搜索范围必须是 last-used、recommended 或 saved:<范围 ID>");
    if (options.boards !== undefined) {
      if (options.scope !== undefined) invalid("boards 与 scope 不能同时使用");
      if (!Array.isArray(options.boards) || !options.boards.length || options.boards.some((name) => typeof name !== "string" || !name.trim())) invalid("boards 必须是非空版面 ID 数组");
      options.boards = [...new Set(options.boards.map((name) => name.trim()))];
    }
    for (const field of ["boardPages", "threadPages"]) if (options[field] !== undefined && options[field] !== null) integer(options[field], 10000);
    if (options.timeRange !== undefined && !["all", "30d", "custom"].includes(options.timeRange)) invalid("日期范围只能是 all、30d 或 custom");
    for (const field of ["dateFrom", "dateTo"]) if (options[field] !== undefined) {
      const value = options[field];
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(`${field} 必须是有效的 YYYY-MM-DD 日期`);
    }
    if ((options.dateFrom || options.dateTo) && options.timeRange !== "custom") invalid("指定日期时请同时设置 timeRange=custom");
    return options;
  }

  function parseUrl(search) {
    const params = new URLSearchParams(search);
    if (!params.has("agent")) return null;
    for (const key of params.keys()) {
      if (!URL_FIELDS.includes(key)) invalid(`不支持的 URL 参数：${key}`);
      if (params.getAll(key).length !== 1) invalid(`URL 参数不能重复：${key}`);
    }
    if (params.get("agent") !== "1") invalid("agent 必须是 1");
    if (params.has("api") && params.get("api") !== "1") invalid("当前仅支持 Agent 协议第 1 版", "UNSUPPORTED_VERSION");
    const action = params.get("action") || "configure";
    if (!["configure", "search"].includes(action)) invalid("action 只能是 configure 或 search");
    const options = {};
    for (const key of SEARCH_FIELDS) if (params.has(key)) {
      let value = params.get(key);
      if (["persist", "confirm"].includes(key)) {
        if (!["0", "1"].includes(value)) invalid(`${key} 只能是 0 或 1`);
        value = value === "1";
      } else if (["boardPages", "threadPages"].includes(key)) {
        if (value !== "all" && !/^\d+$/u.test(value)) invalid(`${key} 必须是整数或 all`);
        value = value === "all" ? null : Number(value);
      } else if (key === "boards") value = value.split(",");
      options[key] = value;
    }
    const pageSize = params.has("pageSize") ? params.get("pageSize") : "20";
    if (!/^\d+$/u.test(pageSize)) invalid("pageSize 必须是整数");
    const stream = params.get("stream") ?? "1";
    if (!["0", "1"].includes(stream)) invalid("stream 只能是 0 或 1");
    let bridge = null;
    if (params.has("bridge") || params.has("bridgePort") || params.has("bridgeToken")) {
      if (params.get("bridge") !== "1") invalid("bridge 必须是 1");
      const bridgePort = params.get("bridgePort");
      const bridgeToken = params.get("bridgeToken") || "";
      if (!/^\d+$/u.test(bridgePort || "") || Number(bridgePort) < 1024 || Number(bridgePort) > 65535) invalid("bridgePort 必须是 1024～65535 的整数");
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(bridgeToken)) invalid("bridgeToken 无效");
      bridge = { port: Number(bridgePort), token: bridgeToken };
    }
    return { action, options: normalizeOptions(options, action === "search"), pageSize: integer(Number(pageSize), 100), stream: stream === "1", bridge };
  }

  function create(adapter) {
    const pageId = crypto.randomUUID();
    let ready = false;
    let initializationError = null;
    let startup = null;
    let starting = false;
    let serial = 0;
    let session = null;
    let pageSize = 20;
    let stream = true;

    const success = (value) => structuredClone({ ok: true, apiVersion: 1, ...value });
    const failure = (error) => ({ ok: false, apiVersion: 1, error: { code: error.code || "INTERNAL_ERROR", message: adapter.userMessage(error) } });
    const guarded = (fn) => (...args) => {
      try { return success(fn(...args)); } catch (error) { return failure(error); }
    };
    const requireReady = () => { if (!ready) invalid(initializationError?.message || "扩展正在初始化，请稍后重试", initializationError?.code || "NOT_READY"); };

    function synchronize() {
      requireReady();
      const view = adapter.view();
      if (!session || session.key !== view.key || session.source !== view.source) {
        session = { id: `${pageId}.${++serial}`, key: view.key, source: view.source, revision: 0, current: new Map(), changes: new Map() };
      }
      const items = adapter.results();
      const present = new Set();
      for (const item of items) {
        present.add(item.id);
        const signature = JSON.stringify(item);
        if (session.current.get(item.id) === signature) continue;
        session.current.set(item.id, signature);
        session.changes.set(item.id, { ...item, operation: "upsert", sequence: ++session.revision });
      }
      for (const id of session.current.keys()) if (!present.has(id)) {
        session.current.delete(id);
        session.changes.set(id, { id, operation: "remove", sequence: ++session.revision });
      }
      return view;
    }

    function status() {
      if (!ready) return { ready, status: initializationError ? "error" : "initializing", error: initializationError, startup };
      const view = synchronize();
      return { ready, searchId: session.id, ...view.status, found: session.current.size, revision: session.revision, startup };
    }

    function currentSearch(options = {}) {
      object(options, ["searchId"]);
      const view = synchronize();
      if (options.searchId !== session.id) invalid("搜索标识已失效，请先读取当前状态", "STALE_SEARCH");
      return view;
    }

    async function startSearch(input = {}) {
      if (starting) return failure(Object.assign(new Error("另一条搜索指令正在启动"), { code: "BUSY" }));
      starting = true;
      try {
        requireReady();
        const options = normalizeOptions(input);
        const prepared = adapter.prepare(options, true);
        await adapter.start(prepared, options);
        session = null;
        return success(status());
      } catch (error) { return failure(error); }
      finally { starting = false; }
    }

    const api = Object.freeze({
      getCapabilities: guarded(() => ({
        name: "邮人全搜", globalName: GLOBAL_NAME, transport: "Chrome DevTools Protocol / 本地 Agent Bridge", ready,
        methods: {
          getCapabilities: {}, getStatus: {}, getContext: {}, getGuide: {}, getResourceUsage: {}, getFailures: {},
          localSearch: { query: "必填；只读取本地索引，不改变主界面或发起论坛请求", scope: "可选", boards: "可选版面 ID 数组", limit: "1～100，默认 20", index: "返回索引条数与最近更新时间" },
          listTasks: { description: "列出最近任务的轻量摘要，不返回完整任务队列或正文" },
          getTask: { searchId: "必填；任务标识" },
          previewSearch: { description: "与 startSearch 参数相同，仅评估范围和请求量" }, setRequestProfile: { profile: ["stable", "fast", "high"] },
          listScopes: {}, listBoards: { query: "可选，版面名称或 ID" },
          startSearch: {
            query: "必填，支持页面现有搜索语法", mode: ["online（默认）", "local"], modeNote: "auto 由 CLI 映射为无界面 local 优先查询，不是 startSearch 的独立任务模式",
            scope: ["last-used（默认）", "recommended", "saved:<范围 ID>"], boards: "可选，版面 ID 数组，与 scope 互斥",
            boardPages: "1～10000；null 表示全部", threadPages: "1～10000；null 表示全部",
            timeRange: ["all", "30d", "custom"], dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD",
            persist: "默认 false；是否保存范围设置和搜索历史。现有任务进度仍会自动保存",
            confirm: "默认 false；替换暂停任务须显式设为 true"
          },
          getResults: { cursor: "可选；原样传入上次返回的 nextCursor", limit: "1～100，默认 20" },
          pauseSearch: { searchId: "必填；暂停当前搜索并保留进度" },
          resumeSearch: { searchId: "必填；继续当前已暂停或部分完成的搜索" },
          retrySearch: { searchId: "必填；只重试当前搜索失败的请求" },
          cancelSearch: { searchId: "必填；兼容旧版本，效果等同于 pauseSearch" }
        },
        url: { activation: "agent=1&api=1", actions: ["configure（默认，仅填入参数）", "search（立即搜索）"], fields: URL_FIELDS,
          encoding: "使用 URLSearchParams 编码；boards 用逗号分隔；页数 all 对应 API 的 null；布尔值使用 0/1",
          pageSize: "1～100；设置 getResults 默认批量大小", stream: "默认 1；0 表示扫描停止后才返回结果" },
        results: { types: ["thread", "reply"], order: "增量变更顺序；相关度见 score", operations: ["upsert：按 id 替换", "remove：按 id 删除"],
          cursor: "绑定当前页面与搜索；切换搜索或刷新后失效。每个 id 合并为最近一次变更", fullContent: false, includesHighlightLinks: true },
        pollingIntervalMs: 1000, maxBatchSize: 100, additionalPermissions: false, bridge: { protocolVersion: 1, host: "127.0.0.1", extensionInitiatesConnection: true }
      })),
      getStatus: guarded(status),
      getContext: guarded(() => {
        requireReady();
        return { context: adapter.context ? adapter.context() : { status: status() } };
      }),
      getGuide: guarded((options = {}) => {
        object(options, ["query"]);
        if (options.query !== undefined && typeof options.query !== "string") invalid("引导查询关键词必须是字符串");
        requireReady();
        return { guide: adapter.guide ? adapter.guide(options) : { schemaVersion: 1, next: { id: "search", command: "node agent-cli.mjs ask --query \"<关键词>\" --mode auto" } } };
      }),
      getResourceUsage: guarded(() => {
        requireReady();
        return { resources: adapter.resources ? adapter.resources() : {} };
      }),
      getFailures: guarded(() => {
        requireReady();
        return { failures: adapter.failures ? adapter.failures() : [] };
      }),
      localSearch: guarded((input = {}) => {
        object(input, [...SEARCH_FIELDS, "limit"]);
        requireReady();
        const limit = integer(input.limit ?? 20, 100);
        const { limit: _limit, ...searchInput } = input;
        const options = normalizeOptions({ ...searchInput, mode: "local" });
        const prepared = adapter.prepare(options, true);
        return adapter.localSearch ? adapter.localSearch(prepared, { ...options, limit }) : { mode: "local", query: options.query, results: [] };
      }),
      listTasks: guarded(() => {
        requireReady();
        return { tasks: adapter.tasks ? adapter.tasks() : [] };
      }),
      getTask: guarded((options = {}) => {
        object(options, ["searchId"]);
        requireReady();
        if (typeof options.searchId !== "string" || !options.searchId) invalid("请提供任务标识");
        const task = adapter.task ? adapter.task(options.searchId) : null;
        if (!task) invalid("找不到指定的搜索任务", "TASK_NOT_FOUND");
        return { task };
      }),
      previewSearch: guarded((input = {}) => {
        requireReady();
        const options = normalizeOptions(input);
        const prepared = adapter.prepare(options, false);
        return { preview: adapter.preview ? adapter.preview(prepared, options) : { mode: prepared.mode, boards: prepared.boards } };
      }),
      setRequestProfile: guarded((options = {}) => {
        object(options, ["profile"]);
        if (typeof options.profile !== "string" || !["stable", "fast", "high"].includes(options.profile)) invalid("请求预设只能是 stable、fast 或 high");
        requireReady();
        return { request: adapter.setRequestProfile ? adapter.setRequestProfile(options.profile) : { profile: options.profile } };
      }),
      listScopes: guarded(() => { requireReady(); return { scopes: adapter.scopes() }; }),
      listBoards: guarded((options = {}) => {
        requireReady(); object(options, ["query"]);
        if (options.query !== undefined && typeof options.query !== "string") invalid("版面查找关键词必须是字符串");
        return { boards: adapter.boards(options.query || "") };
      }),
      startSearch,
      getResults: guarded((options = {}) => {
        object(options, ["cursor", "limit"]);
        const limit = integer(options.limit ?? pageSize, 100);
        const view = synchronize();
        let since = 0;
        if (options.cursor !== undefined) {
          const match = typeof options.cursor === "string" && options.cursor.match(/^(.*):(\d+)$/u);
          if (!match) invalid("读取游标格式无效", "INVALID_CURSOR");
          if (match[1] !== session.id) invalid("搜索已切换或页面已刷新，请不带 cursor 重新读取", "STALE_CURSOR");
          since = Number(match[2]);
          if (!Number.isSafeInteger(since) || since > session.revision) invalid("读取游标超出当前结果版本", "INVALID_CURSOR");
        }
        const waiting = !stream && view.status.running;
        const changes = waiting ? [] : [...session.changes.values()].filter((item) => item.sequence > since).sort((a, b) => a.sequence - b.sequence);
        const items = changes.slice(0, limit);
        const revision = items.at(-1)?.sequence ?? since;
        return { searchId: session.id, items, total: session.current.size, nextCursor: `${session.id}:${revision}`, hasMore: changes.length > limit, running: view.status.running, status: view.status.status };
      }),
      pauseSearch: guarded((options = {}) => {
        currentSearch(options);
        adapter.pause();
        return status();
      }),
      resumeSearch: guarded((options = {}) => {
        currentSearch(options);
        adapter.resume();
        return status();
      }),
      retrySearch: guarded((options = {}) => {
        currentSearch(options);
        adapter.retry();
        return status();
      }),
      cancelSearch: guarded((options = {}) => {
        currentSearch(options);
        adapter.cancel();
        return status();
      })
    });

    return {
      api,
      async initialize(search) {
        ready = true;
        initializationError = null;
        try {
          const command = parseUrl(search);
          if (!command) return { command: null, startup: null };
          pageSize = command.pageSize;
          stream = command.stream;
          if (command.action === "search") {
            startup = await startSearch(command.options);
            if (!startup.ok) return { command, startup };
            startup = { ...startup, action: command.action };
          } else {
            adapter.configure(adapter.prepare(command.options, false), command.options);
            startup = { ok: true, apiVersion: 1, action: command.action };
          }
          return { command, startup };
        } catch (error) { startup = failure(error); return { command: null, startup }; }
      },
      failInitialization(error) { ready = false; initializationError = failure(error).error; }
    };
  }

  return Object.freeze({ create, parseUrl, normalizeOptions, GLOBAL_NAME });
})();
