/* 邮人全搜行为回归测试：验证增量任务、暂停恢复、局部失败重试和完整正文保护。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");

function engine() {
  const context = vm.createContext({ structuredClone });
  vm.runInContext(fs.readFileSync(path.join(root, "task-engine.js"), "utf8"), context);
  return context.ByrTasks;
}

function page() {
  const nodes = new Map();
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: "", textContent: "", hidden: false, disabled: false,
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, style: {}
    });
    return nodes.get(selector);
  } };
  const context = vm.createContext({
    document, URL, URLSearchParams, DOMException, structuredClone, Blob, crypto: webcrypto,
    window: { location: { search: "" }, setTimeout, clearTimeout },
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { async sendMessage() { throw new Error("不应发出请求"); } } }
  });
  const model = fs.readFileSync(path.join(root, "forum-model.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "forum-client.js"), "utf8");
  const agent = fs.readFileSync(path.join(root, "agent-api.js"), "utf8");
  const source = fs.readFileSync(path.join(root, "search.js"), "utf8").replace(/init\(\)\.catch\([\s\S]*$/, "");
  vm.runInContext(fs.readFileSync(path.join(root, "task-engine.js"), "utf8"), context);
  vm.runInContext(agent + "\n" + model + "\n" + client + "\n" + source + "\nglobalThis.api = { state, mergeDocument, requestApi, addOnlineDocument, matchDocument, searchDocuments, compareResults, userResults, renderResults, groupDocumentResults, renderThreadGroup, queryGroups, parseSearchQuery, nativeSearchPaths, highlight, rememberSessionPage, getSessionPage, mergeOnlineDocuments, buildForumDocument, boardPosts, forumThreadId, ForumClient, coverageStatus, rememberIndexedPages, enqueueIndexedPost, shouldReadIndexedPost, agentController };", context);
  return { context, api: context.api };
}

const board = { name: "Talking", description: "谈天说地" };
const options = { boardPageLimit: 2, threadPageLimit: 2, timeRange: null };

test("新发现的正文任务在所有主题列表完成前处理，结果可以即时返回", async () => {
  const tasks = engine();
  const task = tasks.create("online", [board], options, "txf");
  tasks.enqueue(task, { kind: "board", board, page: 1 });
  tasks.enqueue(task, { kind: "board", board, page: 2 });
  const order = [];
  await tasks.run(task, async (job) => {
    order.push(job.kind + job.page);
    if (job.kind === "board" && job.page === 1) {
      tasks.enqueue(task, { kind: "article", board, post: { gid: "1" }, page: 1 }, true);
    }
  }, () => 1, () => {}, new Set());
  assert.deepEqual(order, ["board1", "article1", "board2"]);
  assert.equal(task.phase, "complete");
});

test("暂停保留待处理任务，继续时不重复已完成的页面", async () => {
  const tasks = engine();
  const task = tasks.create("online", [board], options, "txf");
  [1, 2, 3].forEach((page) => tasks.enqueue(task, { kind: "board", board, page }));
  const order = [];
  await tasks.run(task, async (job) => {
    order.push(job.page);
    if (job.page === 1) task.pauseRequested = true;
  }, () => 1, () => {}, new Set());
  assert.equal(task.phase, "paused");
  assert.deepEqual(order, [1]);
  await tasks.run(task, async (job) => { order.push(job.page); }, () => 1, () => {}, new Set());
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(task.phase, "complete");
});

test("单页失败不阻止后续任务，重试只执行失败页", async () => {
  const tasks = engine();
  const task = tasks.create("online", [board], options, "txf");
  [1, 2, 3].forEach((page) => tasks.enqueue(task, { kind: "article", board, post: { gid: "10" }, page }));
  const order = [];
  await tasks.run(task, async (job) => {
    order.push(job.page);
    if (job.page === 2) throw new Error("临时网络错误");
  }, () => 2, () => {}, new Set());
  assert.equal(task.phase, "partial");
  assert.equal(order.length, 3);
  assert.equal(tasks.metrics(task).contentPages, 2);
  task.jobs.filter((job) => job.status === "failed").forEach((job) => { job.status = "pending"; });
  await tasks.run(task, async (job) => { order.push(job.page); }, () => 1, () => {}, new Set());
  assert.deepEqual(order, [1, 2, 3, 2]);
  assert.equal(task.phase, "complete");
  assert.equal(tasks.metrics(task).failures.length, 0);
});

test("恢复快照时，在途页面回到待处理状态，完成页面保持完成", () => {
  const tasks = engine();
  const task = tasks.create("online", [board], options, "txf");
  [1, 2].forEach((page) => tasks.enqueue(task, { kind: "board", board, page }));
  task.jobs[0].status = "done";
  task.jobs[1].status = "running";
  task.phase = "running";
  const restored = tasks.snapshot(task);
  assert.equal(restored.phase, "paused");
  assert.equal(restored.jobs[0].status, "done");
  assert.equal(restored.jobs[1].status, "pending");
  assert.equal(task.jobs[1].status, "running");
});

test("按错误类型区分登录失效和内容权限不足，中文提示不会误暂停任务", async () => {
  const tasks = engine();
  const { api } = page();
  const task = tasks.create("online", [board], options);
  [1, 2].forEach((page) => tasks.enqueue(task, { kind: "article", board, post: { gid: "10" }, page }));
  await tasks.run(task, async (job) => {
    if (job.page === 1) throw api.ForumClient.errorFromResponse({ status: 403 });
  }, () => 1, () => {}, new Set());
  assert.equal(task.phase, "partial");
  assert.equal(task.jobs[0].status, "failed");
  assert.equal(task.jobs[1].status, "done");

  task.jobs[0].status = "pending";
  await tasks.run(task, async () => {
    throw api.ForumClient.errorFromResponse({ status: 401 });
  }, () => 1, () => {}, new Set());
  assert.equal(task.phase, "paused");
  assert.equal(task.jobs[0].status, "pending");
  assert.ok(task.error.includes("打开论坛登录"));
});

test("并发配置动态生效并始终限制活跃任务数", async () => {
  const tasks = engine();
  const task = tasks.create("index", [board], options);
  [1, 2, 3, 4].forEach((page) => tasks.enqueue(task, { kind: "board", board, page }));
  let concurrency = 1;
  let active = 0;
  let peak = 0;
  const schedulers = new Set();
  await tasks.run(task, async (job) => {
    active += 1;
    peak = Math.max(peak, active);
    if (job.page === 1) { concurrency = 2; schedulers.forEach((schedule) => schedule()); }
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, () => concurrency, () => {}, schedulers);
  assert.equal(peak, 2);
  assert.equal(schedulers.size, 0);
});

test("正文保护兼容旧数据，快速候选不能覆盖完整正文，后续完整结果能更新", () => {
  const { api } = page();
  const full = { id: "thread:Talking:1", content: "已有完整正文", authorName: "昵称", time: 123 };
  const quick = { id: full.id, nativeSearch: true, content: "", authorName: "", time: "" };
  assert.equal(api.mergeDocument(full, quick).content, full.content);
  assert.equal(api.mergeDocument(full, quick).authorName, full.authorName);
  assert.equal(api.mergeDocument(full, quick).time, full.time);
  assert.equal(api.mergeDocument(full, { ...quick, content: "新正文", contentFetched: true, nativeSearch: false }).content, "新正文");
});

test("论坛 API 的真实字段也能生成带回帖编号的跳转链接", () => {
  const { api } = page();
  const doc = api.buildForumDocument("Talking", "谈天说地", { gid: "700", reply_count: 8 }, {
    data: { title: "" }
  }, {
    id: "704", position: 4, user: { id: "student", user_name: "同学" },
    content: "", post_time: "2026-10-12 12:00:00"
  });
  assert.equal(doc.pos, 4);
  assert.equal(doc.author, "student");
  assert.equal(doc.authorName, "同学");
  assert.equal(doc.articleId, "704");
  assert.ok(doc.url.includes("byr_article_id=704"));
});

test("暂停阻止已经在全局限速闸门中等待的请求发出", async () => {
  const { api } = page();
  api.state.lastRequestStartedAt = Date.now();
  api.state.requestDelayMs = 30;
  const task = { pauseRequested: false, requests: 0 };
  const pending = api.requestApi("/n/b/section.json", task);
  task.pauseRequested = true;
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(api.state.requestCount, 0);
  assert.equal(task.requests, 0);
});

test("任务去重和覆盖统计使用真实成功状态，不把失败版面算作完成", () => {
  const tasks = engine();
  const task = tasks.create("online", [board], options, "txf");
  tasks.enqueue(task, { kind: "board", board, page: 1 });
  tasks.enqueue(task, { kind: "board", board, page: 1 });
  tasks.enqueue(task, { kind: "article", board, post: { gid: "1" }, page: 1 });
  assert.equal(task.jobs.length, 2);
  task.jobs[0].status = "done";
  task.jobs[1].status = "failed";
  assert.equal(tasks.metrics(task).boards, 0);
  assert.equal(tasks.metrics(task).boardPages, 1);
  assert.equal(tasks.metrics(task).failures.length, 1);
});

test("版面主题优先使用论坛提供的主题 id，失效主题不计入正文统计", () => {
  const { api } = page();
  const posts = api.boardPosts({ article: [{ id: "3320816728", group_id: "过期编号", title: "主题" }] });
  assert.equal(posts[0].gid, "3320816728");
  const tasks = engine();
  const task = tasks.create("index", [board], options);
  tasks.enqueue(task, { kind: "article", board, post: { gid: "3320816728" }, page: 1 });
  task.jobs[0].status = "done";
  task.jobs[0].skipped = true;
  const metrics = tasks.metrics(task);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.contentPages, 0);
  assert.equal(metrics.threads, 0);
});

test("论坛响应分类区分登录失效、主题失效和普通非 JSON", () => {
  const { api } = page();
  assert.equal(api.ForumClient.errorFromResponse({ status: 401, data: { success: false, message: "请登录" } }).code, "LOGIN_REQUIRED");
  assert.equal(api.ForumClient.errorFromResponse({ status: 200, data: { success: false, code: "THREAD_NOT_FOUND", message: "主题不存在" } }).code, "THREAD_NOT_FOUND");
  assert.equal(api.ForumClient.errorFromResponse({ status: 200, data: { success: false, code: "NON_JSON_RESPONSE", message: "论坛返回了非 JSON 内容" } }).code, "NON_JSON_RESPONSE");
  assert.equal(api.ForumClient.nonJsonData("sys exception: \\\"\\\" in threads.php", { headers: { get: () => "text/html" } }).code, "THREAD_NOT_FOUND");
});

test("论坛英文登录响应、登录页和错误代码均转换为中文操作提示", () => {
  const { api } = page();
  const client = api.ForumClient;
  for (const message of ["You haven't login", "You are not logged in.", "Please login first!", "Login required", "Unauthorized", "Your session has expired"]) {
    const error = client.errorFromResponse({ status: 200, data: { success: false, message } });
    assert.equal(error.code, "LOGIN_REQUIRED", message);
    assert.ok(error.message.includes("打开论坛登录"));
    assert.equal(error.message.includes(message), false);
    assert.equal(client.isRetryable(error), false);
  }
  assert.equal(client.errorFromResponse({ data: { success: false, code: "NOT_LOGGED_IN" } }).code, "LOGIN_REQUIRED");
  const loginPage = client.nonJsonData('<html><p>Please login first!</p></html>');
  assert.equal(loginPage.code, "LOGIN_REQUIRED");
  assert.ok(loginPage.message.includes("打开论坛登录"));
});

test("浏览器英文连接与存储异常使用中文，已有中文反馈保持原意", () => {
  const { api, context } = page();
  const client = api.ForumClient;
  const cases = [
    ["Could not establish connection. Receiving end does not exist.", "论坛页面"],
    ["A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received", "论坛页面"],
    ["No tab with id: 123.", "论坛页面"],
    ["Extension context invalidated.", "重新打开插件"],
    ["Failed to fetch", "网络"],
    ["QuotaExceededError: The quota has been exceeded.", "存储空间不足"],
    ["Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", "本地数据"],
    ["Some unexpected internal error", "操作未完成"]
  ];
  for (const [raw, expected] of cases) {
    const translated = client.userMessage(new Error(raw));
    assert.ok(translated.includes(expected), raw);
    assert.equal(translated.includes(raw), false);
  }
  assert.equal(client.userMessage("已保存 3 条在线结果到本地索引"), "已保存 3 条在线结果到本地索引");
  assert.equal(client.userMessage("请先填写范围名称"), "请先填写范围名称");
  assert.equal(client.userMessage("Unknown error", "保存会话失败，请重试"), "保存会话失败，请重试");
  vm.runInContext('showToast("Could not establish connection. Receiving end does not exist.");', context);
  assert.ok(context.document.querySelector("#toast").textContent.includes("论坛页面"));
  assert.equal(context.document.querySelector("#toast").textContent.includes("Could not"), false);
  context.window.clearTimeout(api.state.toastTimer);
});

test("消息通道直接拒绝时也转换为中文，未登录请求只发送一次", async () => {
  const { api, context } = page();
  vm.runInContext("waitForRequestTurn = async () => {};", context);
  context.chrome.runtime.sendMessage = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
  await assert.rejects(api.requestApi("/n/b/section.json"), (error) => error.code === "PAGE_CONNECTION_FAILED" && error.message.includes("论坛页面"));
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls += 1; return { ok: true, data: { success: false, message: "You haven't login" } }; };
  await assert.rejects(api.requestApi("/n/b/section.json"), (error) => error.code === "LOGIN_REQUIRED" && error.message.includes("打开论坛登录"));
  assert.equal(calls, 1);
});

test("自动重试仅处理临时故障，并遵守服务器要求的等待时间", () => {
  const { api } = page();
  const client = api.ForumClient;
  for (const status of [429, 408, 500, 502, 503, 504]) assert.ok(client.isRetryable(client.errorFromResponse({ status })));
  for (const status of [401, 403, 404]) assert.equal(client.isRetryable(client.errorFromResponse({ status })), false);
  assert.equal(client.isRetryable(client.errorFromResponse({ data: { code: "THREAD_NOT_FOUND" } })), false);
  assert.equal(client.retryAfterMs("3"), 3000);
  assert.equal(client.retryAfterMs("Thu, 15 Oct 2026 00:00:10 GMT", Date.parse("2026-10-15T00:00:00Z")), 10000);
  const policy = client.createRequestPolicy();
  const rateLimit = client.errorFromResponse({ status: 429, retryAfterMs: 6000 });
  assert.equal(policy.failed(rateLimit, 0, 1000), 6000);
  assert.equal(policy.limits(8, 50).cooldownUntil, 7000);
  assert.equal(policy.limits(8, 50).concurrency, 4);
  assert.equal(policy.limits(8, 50).delayMs, 250);
  for (let count = 0; count < 12; count += 1) policy.succeeded(3000);
  assert.equal(policy.limits(8, 50).concurrency, 4);
  for (let count = 0; count < 12; count += 1) policy.succeeded(8000);
  assert.equal(policy.limits(8, 50).concurrency, 8);
  assert.equal(policy.limits(8, 50).delayMs, 50);
  const transient = client.errorFromResponse({ status: 503 });
  policy.failed(transient, 0, 9000);
  assert.equal(policy.limits(8, 50).reduced, false);
  policy.failed(transient, 1, 9100);
  assert.equal(policy.limits(8, 50).reduced, true);
  assert.equal(policy.limits(1, 2000).concurrency, 1);
  assert.equal(policy.limits(1, 2000).delayMs, 2000);
});

test("请求最多重试两次，持久失败可交给原任务重试，登录失效不重试", async () => {
  const { api, context } = page();
  vm.runInContext("waitForRequestTurn = async () => {};", context);
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => ++calls < 3 ? { ok: false, status: 503 } : { ok: true, data: { success: true, data: {} } };
  const task = { requests: 0 };
  assert.equal((await api.requestApi("/n/b/section.json", task)).success, true);
  assert.equal(calls, 3);
  assert.equal(task.requests, 3);
  assert.equal(task.retries, 2);
  calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls += 1; return { ok: false, status: 503 }; };
  await assert.rejects(api.requestApi("/n/b/section.json", task), { code: "SERVER_BUSY" });
  assert.equal(calls, 3);
  calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls += 1; return { ok: false, status: 401 }; };
  await assert.rejects(api.requestApi("/n/b/section.json", task), { code: "LOGIN_REQUIRED" });
  assert.equal(calls, 1);
});

test("自动重试冷却期间暂停，不会再向论坛发送请求", async () => {
  const { api, context } = page();
  const task = { requests: 0, pauseRequested: false };
  context.cancelTask = task;
  vm.runInContext("sleep = async () => { cancelTask.pauseRequested = true; };", context);
  let calls = 0;
  context.chrome.runtime.sendMessage = async () => { calls += 1; return { ok: false, status: 503 }; };
  await assert.rejects(api.requestApi("/n/b/section.json", task), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("覆盖状态按当前读取范围判断，过期、缺页和旧索引均不会误报完成", () => {
  const { api } = page();
  const now = Date.now();
  const current = { ...options, timeRangeMode: "all" };
  const record = { options: current, checkedAt: now, complete: true };
  assert.equal(api.coverageStatus(null, current, false, now).label, "未建立索引");
  assert.equal(api.coverageStatus(null, current, true, now).label, "部分索引");
  assert.equal(api.coverageStatus(record, current, true, now).label, "已完成");
  assert.equal(api.coverageStatus(record, { ...current, boardPageLimit: 3 }, true, now).label, "部分索引");
  assert.equal(api.coverageStatus(record, { ...current, threadPageLimit: null }, true, now).label, "部分索引");
  assert.equal(api.coverageStatus({ ...record, complete: false }, current, true, now).label, "部分索引");
  assert.equal(api.coverageStatus(record, current, true, now + 86400000).label, "可能过期");
  assert.equal(api.coverageStatus(record, { ...current, timeRange: { start: 1, end: 2 }, timeRangeMode: "custom" }, true, now).label, "部分索引");
});

test("末页成功不能掩盖前页失败，只更新缺口时复用已写入页且不计作新读取", async () => {
  const { api } = page();
  const tasks = engine();
  const opts = { ...options, threadPageLimit: 3, timeRangeMode: "all", incremental: true, missingOnly: true };
  const post = { gid: "900", title: "资料", replyCount: 28, time: 123 };
  const task = tasks.create("index", [board], opts);
  for (let page = 1; page <= 3; page += 1) tasks.enqueue(task, { kind: "article", board, post, page, totalPages: 3, targetPages: 3 });
  task.jobs.forEach((job) => { job.status = job.page === 2 ? "failed" : "done"; });
  api.rememberIndexedPages(task);
  assert.equal(api.state.indexMetadata["Talking:900"].complete, false);
  assert.deepEqual(Array.from(api.state.indexMetadata["Talking:900"].readPages), [1, 3]);
  const next = tasks.create("index", [board], opts);
  api.enqueueIndexedPost(next, board, post);
  const pagesRead = [];
  await tasks.run(next, async (job) => { pagesRead.push(job.page); job.totalPages = 3; job.targetPages = 3; }, () => 2, () => {}, new Set());
  assert.deepEqual(pagesRead, [2]);
  assert.equal(tasks.metrics(next).reusedPages, 2);
  assert.equal(tasks.metrics(next).contentPages, 1);
  api.rememberIndexedPages(next);
  assert.equal(api.state.indexMetadata["Talking:900"].complete, true);
  assert.equal(api.shouldReadIndexedPost(next, board, post), false);
  const changed = tasks.create("index", [board], opts);
  api.enqueueIndexedPost(changed, board, { ...post, replyCount: 29 });
  assert.equal(changed.jobs.length, 1);
  assert.equal(changed.jobs[0].status, "pending");
  assert.equal(changed.jobs[0].reused, undefined);
});

test("主题标题和版面上下文不能冒充回帖自身命中，正文与作者仍可查询", () => {
  const { api } = page();
  const match = (doc, terms) => api.matchDocument(doc, [terms]);
  const reply = { type: "reply", title: "陶小峰课程讨论", content: "感谢分享", author: "alice", authorName: "同学", boardDescription: "陶小峰讨论版" };
  assert.equal(match(reply, ["陶小峰"]), null);
  assert.notEqual(match({ ...reply, type: "thread" }, ["陶小峰"]), null);
  const body = match({ ...reply, content: "陶小峰的课程" }, ["陶小峰"]);
  assert.deepEqual(Array.from(body.matchedFields), ["content"]);
  assert.deepEqual(Array.from(match(reply, ["alice"]).matchedFields), ["author"]);
  assert.deepEqual(Array.from(match(reply, ["同学"]).matchedFields), ["authorName"]);
  assert.equal(match(reply, ["陶小峰", "alice"]), null);
  assert.notEqual(match({ ...reply, content: "陶小峰的课程" }, ["陶小峰", "alice"]), null);
});

test("时间排序统一支持秒、毫秒和日期文本，未知时间排在已知时间之后", () => {
  const { api } = page();
  api.state.sort = "recent";
  api.state.onlineDocuments = [
    { id: "unknown", type: "thread", title: "目标", time: "无效时间" },
    { id: "seconds", type: "thread", content: "目标", time: Date.parse("2026-10-11T00:00:00") / 1000 },
    { id: "text", type: "thread", content: "目标", time: "2026-10-12 00:00:00" },
    { id: "millis", type: "thread", content: "目标", time: Date.parse("2026-10-10T00:00:00") }
  ];
  assert.deepEqual(Array.from(api.searchDocuments("目标"), item => item.documentData.id), ["text", "seconds", "millis", "unknown"]);
  api.state.sort = "relevance";
  assert.equal(api.searchDocuments("目标")[0].documentData.id, "unknown");
  assert.equal(api.compareResults({ score: 1 }, { score: 1 }), 0);
});

test("用户最近活动也按真实时间聚合和排序", () => {
  const { api } = page();
  api.state.sort = "recent";
  api.state.onlineDocuments = [
    { author: "txfOld", time: "2026-10-10" },
    { author: "txfNew", time: Date.parse("2026-10-11T00:00:00") / 1000 },
    { author: "txfNew", time: "2026-10-12" },
    { author: "txfUnknown", time: "" }
  ];
  const results = api.userResults("txf");
  assert.deepEqual(Array.from(results, result => result.user.id), ["txfNew", "txfOld", "txfUnknown"]);
  assert.equal(results[0].user.latest, "2026-10-12");
  assert.equal(results[0].user.count, 2);
});

test("综合结果遵守时间排序并显示实际命中字段", () => {
  const { context, api } = page();
  api.state.sort = "recent";
  api.state.onlineQuery = "目标";
  api.state.onlineDocuments = [
    { id: "old", type: "thread", title: "目标旧主题", content: "目标", time: "2026-10-10", board: "Talking", gid: "1" },
    { id: "new", type: "reply", title: "新主题", content: "目标新回复", time: Date.parse("2026-10-12T00:00:00") / 1000, board: "Talking", gid: "2", pos: 1 }
  ];
  api.renderResults();
  const html = context.document.querySelector("#result-list").innerHTML;
  assert.ok(html.indexOf("新主题") < html.indexOf("旧主题"));
  assert.ok(html.includes("命中：回帖"));
  assert.ok(html.includes("命中：标题、正文"));
  assert.ok(html.includes('class="result-child" href='));
});

test("OR 分组保持组内同时匹配，合并命中且不把 OR 当作关键词", () => {
  const { api } = page();
  const groups = api.queryGroups("陶小峰 课程 OR txf or TXF");
  assert.deepEqual(Array.from(groups, group => Array.from(group)), [["陶小峰", "课程"], ["txf"], ["txf"]]);
  assert.equal(api.matchDocument({ type: "thread", content: "陶小峰" }, groups), null);
  assert.notEqual(api.matchDocument({ type: "thread", content: "陶小峰课程" }, groups), null);
  const single = api.matchDocument({ type: "reply", content: "讨论txf", title: "无关" }, groups);
  assert.deepEqual(Array.from(single.terms), ["txf"]);
  api.state.onlineDocuments = [
    { id: "name", type: "thread", content: "陶小峰课程" },
    { id: "alias", type: "reply", content: "txf" },
    { id: "both", type: "thread", content: "陶小峰课程 txf" },
    { id: "literal", type: "thread", content: "or" }
  ];
  assert.deepEqual(Array.from(api.searchDocuments("陶小峰 课程 OR txf"), result => result.documentData.id).sort(), ["alias", "both", "name"]);
  assert.equal(api.searchDocuments("陶小峰 txf").length, 1);
  assert.equal(api.queryGroups("OR txf").length, 0);
  assert.equal(api.queryGroups("陶小峰 OR").length, 0);
  assert.equal(api.queryGroups("陶小峰 OR OR txf").length, 0);
  assert.deepEqual(Array.from(api.queryGroups("forum"), group => Array.from(group)), [["forum"]]);
});

test("高级搜索条件只影响匹配范围，不污染关键词和高亮词", () => {
  const { api } = page();
  const parsed = api.parseSearchQuery('"机器 学习" -广告 作者:alice 版面:StudyShare 类型:回帖');
  assert.equal(parsed.valid, true);
  assert.deepEqual(Array.from(parsed.groups, group => Array.from(group)), [["机器 学习"]]);
  assert.deepEqual(Array.from(parsed.terms), ["机器 学习"]);
  assert.deepEqual(Array.from(parsed.excludes), ["广告"]);
  assert.deepEqual({ author: Array.from(parsed.filters.author), board: Array.from(parsed.filters.board), type: Array.from(parsed.filters.type) }, { author: ["alice"], board: ["studyshare"], type: ["reply"] });
  const reply = { type: "reply", content: "机器 学习资料", author: "alice", authorName: "同学", board: "StudyShare", boardDescription: "学习交流" };
  assert.ok(api.matchDocument(reply, parsed.groups, parsed));
  assert.equal(api.matchDocument({ ...reply, content: "机器 学习广告" }, parsed.groups, parsed), null);
  assert.equal(api.matchDocument({ ...reply, author: "bob" }, parsed.groups, parsed), null);
  assert.equal(api.parseSearchQuery('作者:alice').valid, true);
  assert.ok(api.matchDocument({ ...reply, content: "无关键词" }, api.parseSearchQuery('作者:alice').groups, api.parseSearchQuery('作者:alice')));
  assert.equal(api.parseSearchQuery('课程 OR').valid, false);
});

test("主题结果按父子结构保留正文与回帖的独立命中", () => {
  const { api } = page();
  const parent = { documentData: { id: "thread:Talking:1", type: "thread", board: "Talking", gid: "1", title: "主题", content: "标题正文", time: "2026-10-12" }, score: 8, matchedFields: ["title"], terms: ["关键词"] };
  const replyA = { documentData: { id: "reply:Talking:1:2", type: "reply", board: "Talking", gid: "1", title: "主题", content: "回帖关键词 A", pos: 2, time: "2026-10-12" }, score: 4, matchedFields: ["content"], terms: ["关键词"] };
  const replyB = { documentData: { id: "reply:Talking:1:5", type: "reply", board: "Talking", gid: "1", title: "主题", content: "回帖关键词 B", pos: 5, time: "2026-10-12" }, score: 4, matchedFields: ["content"], terms: ["关键词"] };
  const replyOnly = { documentData: { id: "reply:Talking:2:3", type: "reply", board: "Talking", gid: "2", title: "另一个主题", content: "只在回帖中出现关键词", pos: 3, time: "2026-10-12" }, score: 4, matchedFields: ["content"], terms: ["关键词"] };
  const groups = api.groupDocumentResults([parent, replyA, replyB, replyOnly]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].replies.length, 2);
  assert.equal(groups[0].directHit, true);
  assert.equal(groups[1].directHit, false);
  assert.equal(groups[1].documentData.type, "thread");
  assert.equal(groups[1].documentData.gid, "2");
});

test("原生搜索为 OR 每组生成标题和账号请求并去重", () => {
  const { api } = page();
  const paths = api.nativeSearchPaths("Talking", "陶小峰 OR txf OR TXF", options);
  assert.equal(paths.length, 3);
  const urls = paths.map(path => new URL(path, "https://bbs.byr.cn"));
  assert.ok(urls.some(url => decodeURIComponent(url.searchParams.get("t1") || "") === "陶小峰"));
  assert.ok(urls.some(url => url.searchParams.get("t1") === "txf"));
  assert.ok(urls.some(url => url.searchParams.get("au") === "txf"));
  assert.ok(urls.every(url => !url.searchParams.get("t2")));
});

test("多词高亮不会嵌套标签，HTML 和重叠别名仍安全显示", () => {
  const { api } = page();
  assert.equal(api.highlight("TXF tx <img>", ["tx", "txf", "img"]), "<mark>TXF</mark> <mark>tx</mark> &lt;<mark>img</mark>&gt;");
});

test("版面轮转与目录正文交替，长帖不会阻塞其他版面或首轮目录", async () => {
  const tasks = engine();
  const boards = ["A", "B", "C"].map(name => ({ name }));
  const task = tasks.create("online", boards, options, "txf");
  boards.forEach(board => tasks.enqueue(task, { kind: "board", board, page: 1 }));
  const order = [];
  await tasks.run(task, async job => {
    order.push(`${job.board.name}:${job.kind}:${job.page}`);
    if (job.kind === "board") {
      if (job.page === 1) tasks.enqueue(task, { kind: "board", board: job.board, page: 2 });
      tasks.enqueue(task, { kind: "article", board: job.board, post: { gid: String(job.page) }, page: 1 });
    } else if (job.board.name === "A" && job.page < 4) tasks.enqueue(task, { ...job, page: job.page + 1 });
  }, () => 1, () => {}, new Set());
  assert.deepEqual(order.filter(item => item.endsWith(":board:1")), ["A:board:1", "B:board:1", "C:board:1"]);
  assert.ok(order.indexOf("A:article:1") < order.indexOf("C:board:1"));
  assert.ok(order.indexOf("C:board:1") < order.indexOf("A:board:2"));
  assert.ok(order.indexOf("B:article:1") < order.indexOf("A:article:3"));
  assert.equal(task.phase, "complete");
});

test("会话缓存到期或超出页数即不复用，容量超限淘汰旧页", () => {
  const { api } = page();
  const path = "/n/b/article/Talking/7.json?page=2";
  const task = { options: { threadPageLimit: 2 } };
  api.rememberSessionPage(path, { data: { content: "未命中也缓存" } });
  assert.ok(api.getSessionPage(path, task));
  assert.equal(api.getSessionPage(path, { options: { threadPageLimit: 1 } }), null);
  api.state.sessionPages.get(path).fetchedAt = Date.now() - 5 * 60 * 1000;
  assert.equal(api.getSessionPage(path, task), null);
  assert.equal(api.state.sessionCacheBytes, 0);
  const large = { content: "x".repeat(4 * 1024 * 1024) };
  api.rememberSessionPage("first", large);
  api.rememberSessionPage("second", large);
  assert.equal(api.state.sessionPages.has("first"), false);
  assert.ok(api.state.sessionPages.has("second"));
  assert.ok(api.state.sessionCacheBytes <= 8 * 1024 * 1024);
});

test("新正文替换缓存后不再匹配时移除旧命中，较旧缓存不能覆盖较新正文", () => {
  const { api, context } = page();
  vm.runInContext("updateOnlineSearchControls = () => {}; scheduleOnlineRender = () => {};", context);
  const doc = { id: "thread:Talking:1", type: "thread", title: "课程", content: "txf旧正文", contentFetched: true, fetchedAt: 100, cachedAt: 100 };
  api.mergeOnlineDocuments([doc], [["txf"]]);
  api.mergeOnlineDocuments([{ ...doc, content: "txf新正文", fetchedAt: 200, cachedAt: null }], [["txf"]]);
  api.mergeOnlineDocuments([doc], [["txf"]]);
  assert.equal(api.state.onlineDocuments[0].content, "txf新正文");
  api.mergeOnlineDocuments([{ ...doc, content: "已删除关键词", fetchedAt: 300 }], [["txf"]]);
  assert.equal(api.state.onlineDocuments.length, 0);
  assert.equal(api.state.onlineDocumentMap.size, 0);
});

test("会话缓存页数受限，任务快照不包含整个会话缓存", () => {
  const { api } = page();
  for (let index = 0; index < 513; index += 1) api.rememberSessionPage("page" + index, { data: { content: "正文" } });
  assert.equal(api.state.sessionPages.size, 512);
  assert.equal(api.state.sessionPages.has("page0"), false);
  const tasks = engine();
  assert.equal(tasks.snapshot(tasks.create("online", [board], options, "txf")).sessionPages, undefined);
});

test("Agent 协议解析版本化 URL，并拒绝未声明参数", () => {
  const { context } = page();
  const agent = context.ByrAgent;
  const command = agent.parseUrl("?agent=1&api=1&action=search&query=%3C%E5%85%B3%E9%94%AE%E8%AF%8D%3E&mode=online&scope=last-used&boardPages=all&threadPages=3&pageSize=50&stream=0");
  assert.equal(command.action, "search");
  assert.equal(command.options.query, "<关键词>");
  assert.equal(command.options.boardPages, null);
  assert.equal(command.options.threadPages, 3);
  assert.equal(command.pageSize, 50);
  assert.equal(command.stream, false);
  const bridge = agent.parseUrl("?agent=1&api=1&bridge=1&bridgePort=17832&bridgeToken=0123456789abcdef0123456789abcdef");
  assert.equal(bridge.bridge.port, 17832);
  assert.equal(bridge.bridge.token, "0123456789abcdef0123456789abcdef");
  assert.throws(() => agent.parseUrl("?agent=1&api=1&query=x&unknown=y"), /不支持的 URL 参数/);
  assert.throws(() => agent.parseUrl("?agent=1&api=2&action=search&query=x"), (error) => error.code === "UNSUPPORTED_VERSION");
});

test("Agent 能力说明不会暴露完整正文或账号凭据", () => {
  const { api } = page();
  const response = api.agentController.api.getCapabilities();
  assert.equal(response.ok, true);
  assert.equal(response.apiVersion, 1);
  assert.equal(response.data, undefined);
  assert.equal(response.results.fullContent, false);
  assert.equal(response.additionalPermissions, false);
  assert.ok(response.methods.startSearch);
  assert.ok(response.url.fields.includes("scope"));
});
