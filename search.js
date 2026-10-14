/*
 * 邮人全搜核心逻辑：通过论坛同源页面读取公开内容，写入扩展自己的 IndexedDB，
 * 再在浏览器本地或在线扫描范围内完成中文关键词检索。请求采用可调并发与全局限速。
 */

const DB_NAME = "byr-local-search";
const DB_VERSION = 2;
const PERFORMANCE_PRESETS = Object.freeze({
  stable: { label: "省资源", concurrency: 2, delayMs: 500 },
  fast: { label: "平衡", concurrency: 4, delayMs: 200 },
  high: { label: "极速", concurrency: 8, delayMs: 50 }
});
const DEFAULT_REQUEST_PRESET = "high";
const DEFAULT_REQUEST_CONCURRENCY = PERFORMANCE_PRESETS[DEFAULT_REQUEST_PRESET].concurrency;
const DEFAULT_REQUEST_DELAY_MS = PERFORMANCE_PRESETS[DEFAULT_REQUEST_PRESET].delayMs;
const PAGE_SIZE = 10;
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_CACHE_MAX_PAGES = 512;
const BOARD_SELECTION_STORAGE_KEY = "byr-search-board-selection";
const INDEX_OPTIONS_STORAGE_KEY = "byr-search-index-options";
const SCOPE_PRESETS_STORAGE_KEY = "byr-search-scope-presets";
const SEARCH_HISTORY_STORAGE_KEY = "byr-search-history";
const INDEX_METADATA_STORAGE_KEY = "byr-search-index-metadata";
const RECOMMENDED_BOARD_NAMES = [
  "AimGraduate", "GraduateSch", "SICE", "StudyShare", "Talking", "Fujian",
  "SCS", "SCSS", "Paper", "JobInfo", "BBShelp"
];

const sourceTabIdValue = Number(new URLSearchParams(window.location.search).get("sourceTabId"));

const state = {
  sourceTabId: Number.isInteger(sourceTabIdValue) && sourceTabIdValue > 0 ? sourceTabIdValue : null,
  boards: [],
  boardTree: [],
  selectedBoardNames: new Set(),
  scopePresets: [],
  activeScopeId: "current",
  editingScopeId: "current",
  pickerSection: null,
  pickerGroup: null,
  documents: [],
  onlineDocuments: [],
  onlineDocumentMap: new Map(),
  onlineQuery: "",
  sessionPages: new Map(),
  sessionCacheBytes: 0,
  searchMode: "online",
  activeType: "all",
  sort: "relevance",
  indexRunning: false,
  onlineSearchRunning: false,
  onlineRenderTimer: null,
  tasks: { online: null, index: null },
  savingOnlineResults: false,
  checkpointTimer: null,
  checkpointWrites: Promise.resolve(),
  checkpointError: "",
  indexActiveWorkers: 0,
  onlineActiveWorkers: 0,
  requestPreset: DEFAULT_REQUEST_PRESET,
  requestConcurrency: DEFAULT_REQUEST_CONCURRENCY,
  requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
  lastRequestStartedAt: 0,
  requestGate: Promise.resolve(),
  queueSchedulers: new Set(),
  toastTimer: null,
  boardSelectionInitialized: false,
  boardListReady: false,
  boardListLoading: false,
  boardPickerMode: "select",
  boardFilter: "",
  boardSearch: "",
  boardSearchActiveIndex: -1,
  searchHistory: [],
  indexMetadata: {},
  requestCount: 0,
  restoredOnlineTaskId: "",
  settingsBackgroundTargets: [],
  settingsGuardBound: false,
  settingsScrollState: null
};

const $ = (selector) => document.querySelector(selector);

function loadSavedBoardSelection() {
  try {
    const raw = localStorage.getItem(BOARD_SELECTION_STORAGE_KEY);
    if (raw === null) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) {
      state.selectedBoardNames = new Set(saved.filter((name) => typeof name === "string"));
      state.boardSelectionInitialized = true;
    }
  } catch (_error) {
    // 配置损坏时使用推荐版面。
  }
}

function saveBoardSelection() {
  localStorage.setItem(BOARD_SELECTION_STORAGE_KEY, JSON.stringify([...state.selectedBoardNames]));
}

function loadSavedIndexOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_OPTIONS_STORAGE_KEY) || "{}");
    if (Number.isInteger(saved.boardPages) && saved.boardPages >= 1 && saved.boardPages <= 10000) $("#index-board-pages").value = String(saved.boardPages);
    if (Number.isInteger(saved.threadPages) && saved.threadPages >= 1 && saved.threadPages <= 10000) $("#index-thread-pages").value = String(saved.threadPages);
    if (saved.boardAll === true) $("#index-board-all").checked = true;
    if (saved.threadAll === true) $("#index-thread-all").checked = true;
    if (saved.incremental === false) $("#index-incremental").checked = false;
    if (["all", "30d", "custom"].includes(saved.timeRange)) $("#index-time-range").value = saved.timeRange;
    if (typeof saved.dateFrom === "string") $("#index-date-from").value = saved.dateFrom;
    if (typeof saved.dateTo === "string") $("#index-date-to").value = saved.dateTo;
  } catch (_error) {
    // 配置损坏时使用页面默认值。
  }
  $("#index-board-pages").disabled = $("#index-board-all").checked;
  $("#index-thread-pages").disabled = $("#index-thread-all").checked;
  $("#index-custom-dates").hidden = $("#index-time-range").value !== "custom";
}

function indexOptionValues() {
  return {
    boardPages: Number($("#index-board-pages").value),
    threadPages: Number($("#index-thread-pages").value),
    boardAll: $("#index-board-all").checked,
    threadAll: $("#index-thread-all").checked,
    incremental: $("#index-incremental").checked,
    timeRange: $("#index-time-range").value,
    dateFrom: $("#index-date-from").value,
    dateTo: $("#index-date-to").value
  };
}

function saveIndexOptions() {
  localStorage.setItem(INDEX_OPTIONS_STORAGE_KEY, JSON.stringify(indexOptionValues()));
}

function loadIndexMetadata() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_METADATA_STORAGE_KEY) || "{}");
    state.indexMetadata = saved && typeof saved === "object" ? saved : {};
  } catch (_error) {
    state.indexMetadata = {};
  }
}

function saveIndexMetadata() {
  localStorage.setItem(INDEX_METADATA_STORAGE_KEY, JSON.stringify(state.indexMetadata));
}

function indexedPostKey(board, post) {
  return `${board.name}:${String(post.gid)}`;
}

function postReplyCount(post) {
  return post.replyCount ?? post.reply_count ?? post.replyNum ?? post.articleNum ?? null;
}

function postUpdatedTime(post) {
  return post.postTime || post.post_time || post.lastReplyTime || post.last_reply_time || post.time || null;
}

function indexTimeRangeKey(range, mode = "") {
  if (!range) return "all";
  if (mode === "30d") return "30d";
  return `${mode || "custom"}:${range.start}:${range.end}`;
}

function shouldReadIndexedPost(task, board, post) {
  if (task.mode !== "index" || task.options.incremental === false) return true;
  const metadata = state.indexMetadata[indexedPostKey(board, post)];
  if (!metadata || !state.documents.some((doc) => doc.board === board.name && String(doc.gid) === String(post.gid))) return true;
  return String(metadata.replyCount ?? "") !== String(postReplyCount(post) ?? "")
    || String(metadata.postTime ?? "") !== String(postUpdatedTime(post) ?? "")
    || String(metadata.title ?? "") !== String(post.title ?? "")
    || metadata.threadPageLimit !== task.options.threadPageLimit
    || metadata.timeRangeKey !== indexTimeRangeKey(task.options.timeRange, task.options.timeRangeMode);
}

function rememberIndexedPost(task, board, post) {
  state.indexMetadata[indexedPostKey(board, post)] = {
    replyCount: postReplyCount(post),
    postTime: postUpdatedTime(post),
    title: post.title || "",
    threadPageLimit: task.options.threadPageLimit,
    timeRangeKey: indexTimeRangeKey(task.options.timeRange, task.options.timeRangeMode),
    checkedAt: Date.now()
  };
  saveIndexMetadata();
}

function applyIndexOptionValues(options) {
  $("#index-board-pages").value = String(options.boardPages);
  $("#index-thread-pages").value = String(options.threadPages);
  $("#index-board-all").checked = options.boardAll;
  $("#index-thread-all").checked = options.threadAll;
  $("#index-incremental").checked = options.incremental !== false;
  $("#index-time-range").value = options.timeRange;
  $("#index-date-from").value = options.dateFrom;
  $("#index-date-to").value = options.dateTo;
  $("#index-board-pages").disabled = options.boardAll;
  $("#index-thread-pages").disabled = options.threadAll;
  $("#index-custom-dates").hidden = options.timeRange !== "custom";
  updateIndexRangeSummary();
}

function loadScopePresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCOPE_PRESETS_STORAGE_KEY) || "{}");
    state.scopePresets = (Array.isArray(saved.presets) ? saved.presets : []).filter((preset) => {
      const options = preset?.options;
      return typeof preset?.id === "string" && !["current", "recommended"].includes(preset.id)
        && typeof preset.name === "string" && preset.name.trim()
        && Array.isArray(preset.boards) && preset.boards.length && preset.boards.every((name) => typeof name === "string")
        && options && [options.boardPages, options.threadPages].every((pages) => Number.isInteger(pages) && pages >= 1 && pages <= 10000)
        && ["all", "30d", "custom"].includes(options.timeRange);
    });
    // 旧版会按内容自动推断模板，缺少明确来源时保留配置，但按手动选择展示。
    state.activeScopeId = saved.selectionMode === "explicit" && typeof saved.activeId === "string" ? saved.activeId : "current";
  } catch (_error) {
    // 损坏的范围配置不影响现有版面选择和本地索引。
  }
}

function loadSearchHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) || "[]");
    state.searchHistory = Array.isArray(saved) ? saved.filter((item) => item && typeof item.query === "string" && item.query.trim()).slice(0, 12) : [];
  } catch (_error) {
    state.searchHistory = [];
  }
  renderSearchHistory();
}

function saveSearchHistory() {
  localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(state.searchHistory.slice(0, 12)));
}

function rememberSearch(query, mode) {
  const value = String(query || "").trim();
  if (!value) return;
  const entry = { query: value, mode, boards: [...state.selectedBoardNames], options: indexOptionValues(), at: Date.now() };
  state.searchHistory = [entry, ...state.searchHistory.filter((item) => item.query !== value || item.mode !== mode)].slice(0, 12);
  saveSearchHistory();
  renderSearchHistory();
}

function renderSearchHistory() {
  const list = $("#search-history-list");
  if (!list) return;
  list.innerHTML = "";
  if (!state.searchHistory.length) {
    list.innerHTML = '<span class="field-help">暂无搜索记录</span>';
    return;
  }
  state.searchHistory.forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-history-item";
    button.title = entry.query;
    const title = document.createElement("strong");
    title.textContent = entry.query;
    const meta = document.createElement("span");
    meta.textContent = entry.mode === "local" ? "本地" : "在线";
    button.append(title, meta);
    button.addEventListener("click", () => {
      $("#query-input").value = entry.query;
      if (entry.mode === "local") setSearchMode("local");
      else setSearchMode("online");
      if (Array.isArray(entry.boards) && entry.boards.length) setBoardSelection(entry.boards);
      if (entry.options) applyIndexOptionValues(entry.options);
      renderResults();
    });
    list.appendChild(button);
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "text-button search-history-clear";
  clear.textContent = "清空记录";
  clear.addEventListener("click", () => { state.searchHistory = []; saveSearchHistory(); renderSearchHistory(); });
  list.appendChild(clear);
}

function saveScopePresets() {
  localStorage.setItem(SCOPE_PRESETS_STORAGE_KEY, JSON.stringify({ presets: state.scopePresets, activeId: state.activeScopeId, selectionMode: "explicit" }));
}

function scopePreset(id) {
  if (id === "recommended") return {
    id, name: "推荐版面", boards: defaultBoardNames(),
    options: { ...indexOptionValues(), boardPages: 3, threadPages: 3, boardAll: false, threadAll: false, timeRange: "all" }
  };
  return state.scopePresets.find((preset) => preset.id === id);
}

function scopeMatches(preset, boards, options) {
  if (!preset) return false;
  const signature = (names, value) => JSON.stringify([
    [...new Set(names)].sort(), value.boardAll ? null : value.boardPages,
    value.threadAll ? null : value.threadPages, value.timeRange,
    value.incremental !== false,
    ...(value.timeRange === "custom" ? [value.dateFrom, value.dateTo] : [])
  ]);
  return signature(preset.boards, preset.options) === signature(boards, options);
}

function renderScopePresets() {
  const boards = [...state.selectedBoardNames];
  const options = indexOptionValues();
  if (state.boardListReady && state.activeScopeId !== "current" && !scopeMatches(scopePreset(state.activeScopeId), boards, options)) {
    state.activeScopeId = "current";
    saveScopePresets();
  }
  const active = scopePreset(state.activeScopeId);
  $("#scope-presets-summary").textContent = active ? `正在使用：${active.name}`
    : state.scopePresets.length ? `手动选择 · ${state.scopePresets.length} 个已保存组合` : "手动选择 · 可保存组合";
  const list = $("#scope-preset-list");
  const presets = [scopePreset("recommended"), ...state.scopePresets];
  const listKey = JSON.stringify([state.activeScopeId, presets]);
  if (list.scopeMarkup !== listKey) {
    list.scopeMarkup = listKey;
    list.innerHTML = "";
    presets.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "scope-preset-item";
      button.dataset.scopeId = preset.id;
      button.classList.toggle("is-active", state.activeScopeId === preset.id);
      button.setAttribute("aria-pressed", String(state.activeScopeId === preset.id));
      button.title = preset.name;
      button.innerHTML = `<strong>${escapeHtml(preset.name)}</strong><span>${preset.boards.length} 个版面${preset.id === "recommended" ? " · 内置" : ""}</span>`;
      button.addEventListener("click", () => editScopePreset(preset.id));
      list.appendChild(button);
    });
  }
  $("#save-scope-preset").textContent = state.scopePresets.some((preset) => preset.id === state.editingScopeId) ? "保存修改" : "保存范围";
  $("#delete-scope-preset").hidden = !state.scopePresets.some((preset) => preset.id === state.editingScopeId);
}

function editScopePreset(id) {
  const preset = scopePreset(id);
  if (!preset) return;
  selectScopePreset(id);
  const missing = preset.boards.length - state.selectedBoardNames.size;
  $("#scope-preset-feedback").textContent = missing > 0
    ? `有 ${missing} 个版面不在当前列表中，可刷新版面后再选择此范围。`
    : "修改只影响新搜索，已开始的任务保持原范围。";
  renderScopePresets();
}

function saveScopePreset() {
  const feedback = $("#scope-preset-feedback");
  try {
    const name = $("#scope-preset-name").value.trim();
    if (!name) throw new Error("请先填写范围名称");
    if (!state.selectedBoardNames.size) throw new Error("请至少选择一个版面");
    readIndexOptions();
    if (state.scopePresets.some((preset) => preset.id !== state.editingScopeId && preset.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("已有同名范围，请换一个名称");
    const previous = state.scopePresets.find((preset) => preset.id === state.editingScopeId);
    const options = indexOptionValues();
    // “全部”模式允许停用的页数为空，保存时仍保留可恢复的有效默认值。
    if (options.boardAll && (!Number.isInteger(options.boardPages) || options.boardPages < 1 || options.boardPages > 10000)) options.boardPages = 3;
    if (options.threadAll && (!Number.isInteger(options.threadPages) || options.threadPages < 1 || options.threadPages > 10000)) options.threadPages = 3;
    const preset = { id: previous?.id || crypto.randomUUID(), name, boards: [...state.selectedBoardNames], options };
    const next = previous ? state.scopePresets.map((item) => item.id === previous.id ? preset : item) : [...state.scopePresets, preset];
    localStorage.setItem(SCOPE_PRESETS_STORAGE_KEY, JSON.stringify({ presets: next, activeId: preset.id, selectionMode: "explicit" }));
    state.scopePresets = next;
    state.editingScopeId = preset.id;
    state.activeScopeId = preset.id;
    saveBoardSelection();
    saveIndexOptions();
    feedback.textContent = `已保存“${name}”，后续搜索使用当前范围。`;
    $("#manual-board-details").open = false;
    renderScopePresets();
  } catch (error) {
    feedback.textContent = error.message || "范围保存失败";
  }
}

function deleteScopePreset() {
  const preset = state.scopePresets.find((item) => item.id === state.editingScopeId);
  if (!preset || !window.confirm(`删除搜索范围“${preset.name}”？本地索引和搜索结果会保留。`)) return;
  state.scopePresets = state.scopePresets.filter((item) => item.id !== preset.id);
  state.editingScopeId = "current";
  $("#scope-preset-name").value = "";
  saveScopePresets();
  renderScopePresets();
  $("#scope-preset-feedback").textContent = "范围已删除，当前勾选仍可用于搜索。";
}

function selectScopePreset(id) {
  const preset = scopePreset(id);
  if (!preset) {
    state.editingScopeId = "current";
    $("#scope-preset-name").value = "";
    $("#scope-presets-details").open = true;
    renderScopePresets();
    return;
  }
  applyIndexOptionValues(preset.options);
  setBoardSelection(preset.boards);
  state.activeScopeId = scopeMatches(preset, [...state.selectedBoardNames], indexOptionValues()) ? id : "current";
  state.editingScopeId = id;
  $("#scope-preset-name").value = id === "recommended" ? "" : preset.name;
  saveScopePresets();
  renderScopePresets();
  renderResults();
  const missing = preset.boards.length !== state.selectedBoardNames.size;
  $("#manual-board-details").open = missing;
  if (missing) showToast("部分版面不在当前列表中，请展开搜索版面刷新检查");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("boards")) {
        db.createObjectStore("boards", { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains("tasks")) db.createObjectStore("tasks", { keyPath: "mode" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("请关闭旧版邮人全搜标签页，再重新打开，以升级本地任务存储"));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("本地存储操作中断")); };
  });
}

function getAll(storeName) {
  return withStore(storeName, "readonly", (store) => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

function put(storeName, value) {
  return withStore(storeName, "readwrite", (store) => store.put(value));
}

function putMany(storeName, values) {
  return withStore(storeName, "readwrite", (store) => {
    values.forEach((value) => store.put(value));
    return values.length;
  });
}

function clearStore(storeName) {
  return withStore(storeName, "readwrite", (store) => store.clear());
}

function mergeDocument(previous, incoming) {
  if (!previous) return incoming;
  const previousComplete = previous.contentFetched || Boolean(previous.content && !previous.nativeSearch);
  const incomingComplete = incoming.contentFetched || Boolean(incoming.content && !incoming.nativeSearch);
  if (previousComplete && !incomingComplete) {
    return { ...previous, boardDescription: incoming.boardDescription || previous.boardDescription };
  }
  return { ...previous, ...incoming, ...(incomingComplete ? { nativeSearch: false } : {}) };
}

function saveDocuments(values) {
  return withStore("documents", "readwrite", (store) => {
    values.forEach((incoming) => {
      const request = store.get(incoming.id);
      request.onsuccess = () => {
        store.put({ ...mergeDocument(request.result, incoming), updatedAt: Date.now() });
      };
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function checkTaskCancelled(task) {
  if (task?.pauseRequested) throw new DOMException("任务已暂停", "AbortError");
}

async function waitForRequestTurn(task) {
  let releaseGate;
  const previousGate = state.requestGate;
  state.requestGate = new Promise((resolve) => { releaseGate = resolve; });
  await previousGate;
  try {
    checkTaskCancelled(task);
    let remaining = state.lastRequestStartedAt + state.requestDelayMs - Date.now();
    while (remaining > 0) {
      await sleep(Math.min(remaining, 100));
      checkTaskCancelled(task);
      remaining = state.lastRequestStartedAt + state.requestDelayMs - Date.now();
    }
    state.lastRequestStartedAt = Date.now();
  } finally {
    releaseGate();
  }
}

function updatePerformanceLiveStatus() {
  let label = "当前空闲";
  if (state.onlineSearchRunning) label = `在线搜索 · ${state.onlineActiveWorkers} 个活跃任务`;
  else if (state.indexRunning) label = `更新索引 · ${state.indexActiveWorkers} 个活跃任务`;
  $("#performance-live-status").textContent = label;
}

function updatePerformanceConfig(save = true) {
  const concurrency = Number($("#request-concurrency").value);
  const delay = Number($("#request-delay").value);
  if (Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8) state.requestConcurrency = concurrency;
  if (Number.isInteger(delay) && delay >= 50 && delay <= 5000) state.requestDelayMs = delay;
  const preset = PERFORMANCE_PRESETS[state.requestPreset];
  $("#performance-summary").textContent = preset
    ? `${preset.label} · 同时 ${state.requestConcurrency} 个 · 每 ${state.requestDelayMs} 毫秒启动`
    : `自定义 · 同时 ${state.requestConcurrency} 个 · 每 ${state.requestDelayMs} 毫秒启动`;
  $("#custom-performance").hidden = state.requestPreset !== "custom";
  if (save) {
    localStorage.setItem("byr-search-performance", JSON.stringify({
      mode: state.requestPreset,
      concurrency: state.requestConcurrency,
      delayMs: state.requestDelayMs
    }));
  }
  state.queueSchedulers.forEach((schedule) => schedule());
  updatePerformanceLiveStatus();
}

function loadPerformanceConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem("byr-search-performance") || "{}");
    if (PERFORMANCE_PRESETS[saved.mode]) {
      state.requestPreset = saved.mode;
      state.requestConcurrency = PERFORMANCE_PRESETS[saved.mode].concurrency;
      state.requestDelayMs = PERFORMANCE_PRESETS[saved.mode].delayMs;
    } else if (Number.isInteger(saved.concurrency) && saved.concurrency >= 1 && saved.concurrency <= 8
      && Number.isInteger(saved.delayMs) && saved.delayMs >= 50 && saved.delayMs <= 5000) {
      // 旧版默认值过于保守；只迁移旧默认值，用户自定义值仍保留。
      if (saved.concurrency === 2 && saved.delayMs === 800) {
        state.requestPreset = DEFAULT_REQUEST_PRESET;
        state.requestConcurrency = DEFAULT_REQUEST_CONCURRENCY;
        state.requestDelayMs = DEFAULT_REQUEST_DELAY_MS;
      } else {
        state.requestPreset = "custom";
        state.requestConcurrency = saved.concurrency;
        state.requestDelayMs = saved.delayMs;
      }
    }
  } catch (_error) {
    // 配置损坏时使用安全的默认值。
  }
  $("#request-speed").value = state.requestPreset;
  $("#request-concurrency").value = String(state.requestConcurrency);
  $("#request-delay").value = String(state.requestDelayMs);
  updatePerformanceConfig(false);
}

function normalizePerformanceInput() {
  $("#request-concurrency").value = String(state.requestConcurrency);
  $("#request-delay").value = String(state.requestDelayMs);
}


function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "无法估算";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function refreshResourceUsage() {
  const payload = JSON.stringify({ documents: state.documents, boards: state.boards });
  $("#resource-documents").textContent = `${state.documents.length} 条`;
  $("#resource-boards").textContent = `${state.boards.length} 个`;
  $("#resource-data-size").textContent = formatBytes(new Blob([payload]).size);
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    const usage = formatBytes(estimate.usage);
    const quota = formatBytes(estimate.quota);
    $("#resource-storage").textContent = `${usage} / ${quota}`;
  } else {
    $("#resource-storage").textContent = "浏览器未提供";
  }
  const memory = performance.memory;
  $("#resource-memory").textContent = memory ? `${formatBytes(memory.usedJSHeapSize)} / ${formatBytes(memory.jsHeapSizeLimit)}` : "浏览器未提供";
  $("#resource-requests").textContent = `${state.requestCount} 次`;
  $("#resource-summary").textContent = `${state.documents.length} 条内容 · ${formatBytes(new Blob([payload]).size)}`;
  pruneSessionPages();
  $("#resource-session-cache").textContent = `${state.sessionPages.size} 页 · ${formatBytes(state.sessionCacheBytes)}`;
}

function setIndexStatus(message, progress = null) {
  $("#index-status-summary").textContent = message;
  $("#index-status-details").textContent = "";
  if (progress !== null) {
    $("#index-progress").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function queryGroups(query) {
  const groups = query.trim().toLocaleLowerCase().split(/(?:^|\s)or(?=\s|$)/u)
    .map((group) => [...new Set(group.trim().split(/\s+/u).filter(Boolean))]);
  return groups.every((group) => group.length) ? groups : [];
}

function termsFromQuery(query) {
  return [...new Set(queryGroups(query).flat())];
}

function matchingTerms(text, groups) {
  return [...new Set(groups.filter((group) => group.every((term) => text.includes(term))).flat())];
}

function highlight(value, terms) {
  const alternatives = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alternatives.length) return escapeHtml(value);
  return String(value || "").split(new RegExp(`(${alternatives.join("|")})`, "giu"))
    .map((part, index) => index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join("");
}

function htmlToText(html) {
  if (!html) return "";
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(String(html), "text/html");
  return (documentNode.body.textContent || "").replace(/\s+/gu, " ").trim();
}

function getSnippet(text, terms) {
  const plain = String(text || "").replace(/\s+/gu, " ").trim();
  if (!plain) return "";
  const lower = plain.toLocaleLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const position = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, position - 72);
  const end = Math.min(plain.length, position + 168);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

function formatTime(value) {
  if (!value) return "时间未知";
  if (/^\d{4}-\d{2}-\d{2}/u.test(String(value))) return String(value).slice(0, 16);
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return String(value);
  return new Date(timestamp < 100000000000 ? timestamp * 1000 : timestamp).toLocaleString("zh-CN", { hour12: false });
}

function threadUrl(doc, highlightTerms = []) {
  const base = `https://bbs.byr.cn/#!article/${encodeURIComponent(doc.board)}/${encodeURIComponent(doc.gid)}`;
  const params = new URLSearchParams();
  if (doc.type === "reply" && doc.pos) params.set("p", String(Math.max(1, Math.floor(Number(doc.pos) / PAGE_SIZE) + 1)));
  if (doc.articleId) params.set("byr_article_id", String(doc.articleId));
  const terms = [...new Set((Array.isArray(highlightTerms) ? highlightTerms : []).map((term) => String(term || "").trim()).filter(Boolean))].slice(0, 8);
  if (terms.length) params.set("byr_highlight", terms.join("|"));
  const query = params.toString();
  const anchor = doc.type === "reply" && doc.pos ? `#a${encodeURIComponent(doc.pos)}` : "";
  return `${base}${query ? `?${query}` : ""}${anchor}`;
}

function userUrl(id) {
  return `https://bbs.byr.cn/user/query/${encodeURIComponent(id)}`;
}

function boardUrl(name) {
  return `https://bbs.byr.cn/#!board/${encodeURIComponent(name)}`;
}

async function requestApi(path, task) {
  await waitForRequestTurn(task);
  state.requestCount += 1;
  if (task) task.requests += 1;
  $("#resource-requests").textContent = `${state.requestCount} 次`;
  const response = await chrome.runtime.sendMessage({
    type: "api-via-page",
    sourceTabId: state.sourceTabId,
    path
  });
  if (Number.isInteger(response?.sourceTabId)) state.sourceTabId = response.sourceTabId;
  if (!response?.ok || !response.data?.success) {
    if (response?.status === 401 || response?.data?.message?.includes("登录")) {
      throw new Error("论坛登录已失效，请先在论坛页面重新登录");
    }
    throw new Error(response?.data?.message || response?.error || "论坛请求失败");
  }
  return response.data;
}

async function requestForumText(path, task) {
  await waitForRequestTurn(task);
  state.requestCount += 1;
  if (task) task.requests += 1;
  $("#resource-requests").textContent = `${state.requestCount} 次`;
  const response = await chrome.runtime.sendMessage({
    type: "api-via-page",
    sourceTabId: state.sourceTabId,
    path
  });
  if (Number.isInteger(response?.sourceTabId)) state.sourceTabId = response.sourceTabId;
  const text = String(response?.text || "");
  if (!response?.ok) throw new Error(response?.error || "论坛原生搜索请求失败");
  if (text.includes("您未登录") || text.includes("请登录后继续操作")) {
    throw new Error("论坛登录已失效，请先在论坛页面重新登录");
  }
  return text;
}

function flattenBoards(nodes, output = []) {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if (isDirectoryNode(node)) {
      flattenBoards(node.children, output);
    } else {
      const name = boardNameFromNode(node);
      if (name) output.push({ name, description: node?.name || name });
    }
  });
  return output;
}

function uniqueBoards(boards) {
  const unique = new Map();
  (Array.isArray(boards) ? boards : []).forEach((board) => {
    const name = String(board?.name || "").trim();
    if (!name) return;
    const key = name.toLocaleLowerCase();
    const current = unique.get(key);
    if (!current || current.description === current.name) {
      unique.set(key, { name, description: String(board.description || name).trim() });
    }
  });
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function isDirectoryNode(node) {
  return node?.dir === true || node?.dir === 1 || node?.dir === "1" || node?.dir === "true"
    || (Array.isArray(node?.children) && node.children.length > 0);
}

function cachedBoardTree(boards) {
  return [{
    dir: true,
    name: "已缓存版面",
    desc: "本地缓存",
    children: boards.map((board) => ({ dir: false, name: board.description || board.name, desc: board.name }))
  }];
}

function boardNameFromNode(node) {
  if (!node || isDirectoryNode(node)) return "";
  return String(node.desc || node.name || "").trim();
}

function descendantBoardNodes(nodes, output = []) {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if (isDirectoryNode(node)) descendantBoardNodes(node.children, output);
    else if (boardNameFromNode(node)) output.push(node);
  });
  return output;
}

function nodeHasSelectedBoard(node) {
  if (!isDirectoryNode(node)) return state.selectedBoardNames.has(boardNameFromNode(node));
  return (node.children || []).some((child) => nodeHasSelectedBoard(child));
}

function resolveBoardNames(names) {
  const available = new Map();
  state.boards.forEach((board) => {
    available.set(board.name.toLocaleLowerCase(), board.name);
    available.set(String(board.description || "").toLocaleLowerCase(), board.name);
  });
  return [...new Set((Array.isArray(names) ? names : []).map((name) => available.get(String(name).toLocaleLowerCase())).filter(Boolean))];
}

function defaultBoardNames() {
  const recommended = resolveBoardNames(RECOMMENDED_BOARD_NAMES);
  return recommended.length ? recommended : state.boards.slice(0, 10).map((board) => board.name);
}

async function loadBoards(showMessage = false) {
  if (state.boardListLoading) return;
  const hadUsableBoards = state.boards.length > 0;
  state.boardListLoading = true;
  if (!hadUsableBoards) state.boardListReady = false;
  updateIndexButtonState();
  $("#refresh-boards").disabled = true;
  $("#refresh-boards").textContent = "正在读取版面…";
  $("#login-state").textContent = "加载版面";
  $("#login-state").classList.remove("is-ready");
  renderBoardPicker();
  try {
    const result = await requestApi("/n/b/section.json");
    const nextBoardTree = Array.isArray(result.data?.boards) ? result.data.boards : [];
    const nextBoards = uniqueBoards(flattenBoards(nextBoardTree));
    if (!nextBoards.length) throw new Error("论坛目录中没有识别到具体版面，已保留本地缓存");
    state.boardTree = nextBoardTree;
    state.boards = nextBoards;
    await clearStore("boards");
    await Promise.all(state.boards.map((board) => put("boards", board)));
    state.boardListReady = state.boards.length > 0;
    renderBoardOptions();
    $("#login-state").textContent = state.boardListReady ? "已连接" : "无可用版面";
    $("#login-state").classList.toggle("is-ready", state.boardListReady);
    await refreshResourceUsage();
    if (showMessage) showToast(`已读取 ${state.boards.length} 个版面`);
  } catch (error) {
    if (hadUsableBoards) {
      state.boardListReady = true;
      if (!state.boardTree.length) state.boardTree = cachedBoardTree(state.boards);
      $("#login-state").textContent = "使用缓存版面";
      $("#login-state").classList.add("is-ready");
    } else {
      $("#login-state").textContent = "未连接";
      $("#login-state").classList.remove("is-ready");
    }
    throw error;
  } finally {
    state.boardListLoading = false;
    if (!state.boardTree.length) renderBoardPicker();
    updateIndexButtonState();
    $("#refresh-boards").disabled = false;
    $("#refresh-boards").textContent = "从论坛读取/刷新版面";
  }
}

function renderBoardOptions() {
  const select = $("#board-select");
  state.selectedBoardNames = new Set(resolveBoardNames([...state.selectedBoardNames]));
  const selected = new Set(state.selectedBoardNames);
  const shouldUseRecommended = !state.boardSelectionInitialized && selected.size === 0;
  if (shouldUseRecommended) {
    state.selectedBoardNames = new Set(defaultBoardNames());
  }
  select.innerHTML = state.boards.map((board) => `<option value="${escapeHtml(board.name)}" title="${escapeHtml(board.description)}">${escapeHtml(board.name)} · ${escapeHtml(board.description)}</option>`).join("");
  Array.from(select.options).forEach((option) => {
    option.selected = state.selectedBoardNames.has(option.value);
  });
  state.boardSelectionInitialized = true;
  if (!state.pickerSection || !state.boardTree.includes(state.pickerSection)) {
    state.pickerSection = state.boardTree[0] || null;
    state.pickerGroup = null;
  }
  if (state.pickerGroup && !(state.pickerSection?.children || []).includes(state.pickerGroup)) state.pickerGroup = null;
  renderFlatBoardList();
  renderBoardPicker();
  updateBoardSelectionStatus();
}

function updateBoardSelectionStatus() {
  const count = state.selectedBoardNames.size;
  const total = state.boards.length;
  $("#board-selection-status").textContent = total
    ? (count ? `已选 ${count} / ${total} 个版面` : `未选择版面，共 ${total} 个`)
    : "尚未读取版面";
  updateIndexButtonState();
  updateOnlineSearchControls();
  if (state.searchMode === "local") renderResults();
}

function updateIndexButtonState() {
  const task = state.tasks.index;
  const selectedCount = state.selectedBoardNames.size;
  $("#start-index").disabled = state.indexRunning || state.onlineSearchRunning || state.boardListLoading || (!task || task.phase !== "paused") && (!state.boardListReady || selectedCount === 0);
  $("#start-index").textContent = task?.phase === "paused" ? "继续更新" : "更新本地索引";
}

function setBoardSelection(names) {
  state.selectedBoardNames = new Set(state.boards.length ? resolveBoardNames(names) : []);
  saveBoardSelection();
  Array.from($("#board-select").options).forEach((option) => { option.selected = state.selectedBoardNames.has(option.value); });
  renderFlatBoardList();
  renderBoardPicker();
  updateBoardSelectionStatus();
}

function createBoardNode(node, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "board-node";
  if (active) button.classList.add("is-active");
  const boardName = boardNameFromNode(node);
  if (boardName && state.selectedBoardNames.has(boardName)) button.classList.add("is-selected");
  const label = document.createElement("span");
  label.className = "board-node-label";
  label.textContent = isDirectoryNode(node) ? `${node.name} · ${node.desc || "目录"}` : `${node.name} · ${node.desc || node.name}`;
  button.title = label.textContent;
  button.appendChild(label);
  if (boardName && state.selectedBoardNames.has(boardName)) {
    const mark = document.createElement("span");
    mark.className = "board-node-mark";
    mark.textContent = "✓";
    button.appendChild(mark);
  }
  button.addEventListener("click", onClick);
  return button;
}

function renderFlatBoardList() {
  const list = $("#board-flat-list");
  const terms = state.boardFilter.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const boards = state.boards.filter((board) => state.selectedBoardNames.has(board.name)).filter((board) => {
    const fields = `${board.description} ${board.name}`.toLocaleLowerCase();
    return terms.every((term) => fields.includes(term));
  });
  list.innerHTML = "";
  boards.forEach((board) => {
    const label = document.createElement("label");
    label.className = "board-flat-item";
    if (state.selectedBoardNames.has(board.name)) label.classList.add("is-selected");
    label.title = `${board.description} · ${board.name}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedBoardNames.has(board.name);
    checkbox.addEventListener("change", () => {
      toggleBoardSelection(board.name);
      renderFlatBoardList();
      renderBoardPicker();
    });
    const text = document.createElement("span");
    text.textContent = `${board.description} · ${board.name}`;
    label.append(checkbox, text);
    list.appendChild(label);
  });
  if (!boards.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = state.selectedBoardNames.size ? "没有符合筛选条件的已选版面" : "尚未选择版面";
    list.appendChild(empty);
  }
}

function boardSearchMatches() {
  const query = state.boardSearch.trim().toLocaleLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/u).filter(Boolean);
  const boards = state.boards.filter((board) => terms.every((term) => `${board.description} ${board.name}`.toLocaleLowerCase().includes(term)));
  boards.sort((a, b) => Number(state.selectedBoardNames.has(b.name)) - Number(state.selectedBoardNames.has(a.name)));
  return boards;
}

function renderBoardSearchResults() {
  const container = $("#board-search-results");
  const query = state.boardSearch.trim().toLocaleLowerCase();
  container.innerHTML = "";
  if (!query) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const boards = boardSearchMatches();
  boards.forEach((board, index) => {
    const label = document.createElement("label");
    label.className = "board-search-item";
    if (state.selectedBoardNames.has(board.name)) label.classList.add("is-selected");
    if (index === state.boardSearchActiveIndex) label.classList.add("is-active");
    label.title = `${board.description} · ${board.name}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedBoardNames.has(board.name);
    checkbox.addEventListener("change", () => {
      toggleBoardSelection(board.name);
      renderBoardSearchResults();
    });
    const text = document.createElement("span");
    text.textContent = `${board.description} · ${board.name}`;
    label.append(checkbox, text);
    container.appendChild(label);
  });
  if (!boards.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = state.boards.length ? "没有匹配的版面" : "请先刷新版面列表";
    container.appendChild(empty);
  }
}

function setBoardPickerMode(mode) {
  state.boardPickerMode = mode === "review" ? "review" : "select";
  const selecting = state.boardPickerMode === "select";
  $("#board-mode-select").classList.toggle("is-active", selecting);
  $("#board-mode-review").classList.toggle("is-active", !selecting);
  $("#board-mode-select").setAttribute("aria-selected", String(selecting));
  $("#board-mode-review").setAttribute("aria-selected", String(!selecting));
  $("#board-select-view").classList.toggle("is-active", selecting);
  $("#board-review-view").classList.toggle("is-active", !selecting);
  $("#board-select-view").setAttribute("aria-hidden", String(!selecting));
  $("#board-review-view").setAttribute("aria-hidden", String(selecting));
  $("#board-mode-hint").textContent = selecting ? "按分区勾选需要搜索的版面" : "从大列表检查已经勾选的版面";
  renderFlatBoardList();
  renderBoardPicker();
}

function renderBoardPicker() {
  const sectionList = $("#board-section-list");
  const groupList = $("#board-group-list");
  const leafList = $("#board-leaf-list");
  sectionList.innerHTML = "";
  groupList.innerHTML = "";
  leafList.innerHTML = "";
  if (!state.boardTree.length) {
    const message = state.boardListLoading ? "正在加载版面…" : "请先刷新版面列表";
    [sectionList, groupList, leafList].forEach((list) => {
      const empty = document.createElement("p");
      empty.className = "board-empty";
      empty.textContent = message;
      list.appendChild(empty);
    });
    return;
  }
  const selectedSections = state.boardPickerMode === "select"
    ? state.boardTree
    : state.boardTree.filter((section) => nodeHasSelectedBoard(section));
  if (!selectedSections.includes(state.pickerSection)) {
    state.pickerSection = selectedSections[0] || null;
    state.pickerGroup = null;
  }
  selectedSections.forEach((section) => sectionList.appendChild(createBoardNode(section, state.pickerSection === section, () => {
    state.pickerSection = section;
    state.pickerGroup = null;
    renderBoardPicker();
  })));
  if (!selectedSections.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = "尚未选择版面";
    sectionList.appendChild(empty);
  }
  const sectionChildren = state.pickerSection?.children || [];
  const groupNodes = sectionChildren.filter((node) => isDirectoryNode(node) && (state.boardPickerMode === "select" || nodeHasSelectedBoard(node)));
  const directBoardNodes = sectionChildren.filter((node) => !isDirectoryNode(node) && (state.boardPickerMode === "select" || nodeHasSelectedBoard(node)));
  if (state.pickerGroup && !groupNodes.includes(state.pickerGroup)) state.pickerGroup = null;
  groupNodes.forEach((node) => groupList.appendChild(createBoardNode(node, state.pickerGroup === node, () => {
    state.pickerGroup = node;
    renderBoardPicker();
  })));
  if (!groupNodes.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = state.boardPickerMode === "select" ? "该分区没有子目录" : "该分区没有已选目录";
    groupList.appendChild(empty);
  }
  const leafNodes = state.pickerGroup
    ? descendantBoardNodes(state.pickerGroup.children).filter((node) => state.boardPickerMode === "select" || nodeHasSelectedBoard(node))
    : directBoardNodes;
  leafNodes.forEach((node) => leafList.appendChild(createBoardNode(node, false, () => {
    toggleBoardSelection(boardNameFromNode(node));
    renderBoardPicker();
  })));
  if (!leafNodes.length) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = state.boardPickerMode === "select" ? "该目录没有具体版面" : (state.pickerGroup ? "该目录没有已选版面" : "请先选择中栏目录");
    leafList.appendChild(empty);
  }
}

function toggleBoardSelection(name) {
  if (state.selectedBoardNames.has(name)) state.selectedBoardNames.delete(name);
  else state.selectedBoardNames.add(name);
  saveBoardSelection();
  Array.from($("#board-select").options).forEach((option) => { option.selected = state.selectedBoardNames.has(option.value); });
  updateBoardSelectionStatus();
  renderFlatBoardList();
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setDefaultCustomDates() {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86400000);
  $("#index-date-from").value = dateInputValue(from);
  $("#index-date-to").value = dateInputValue(to);
}

function updateIndexRangeSummary() {
  const boardPages = $("#index-board-all").checked ? "每版全部" : `每版 ${$("#index-board-pages").value || "--"} 页`;
  const threadPages = $("#index-thread-all").checked ? "每帖全部" : `每帖 ${$("#index-thread-pages").value || "--"} 页`;
  const timeMode = $("#index-time-range").value;
  const timeLabel = timeMode === "30d" ? "最近 30 天" : timeMode === "custom"
    ? `${$("#index-date-from").value || "开始日期"} 至 ${$("#index-date-to").value || "结束日期"}`
    : "不限时间";
  $("#index-range-summary").textContent = `${boardPages} · ${threadPages} · ${timeLabel}`;
  saveIndexOptions();
  updateOnlineSearchControls();
  if (state.searchMode === "local") renderResults();
}


function boardPosts(data) {
  const posts = [...(data?.posts || []), ...(data?.topPosts || []), ...(data?.article || [])]
    .map((post) => ({ ...post, gid: String(post?.gid ?? post?.group_id ?? post?.id ?? "") }));
  const seen = new Set();
  return posts.filter((post) => {
    const id = String(post?.gid || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseForumTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const text = String(value).trim();
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(text.replace(/-/gu, "/"));
  return Number.isFinite(fallback) ? fallback : null;
}

function readIndexTimeRange(values = indexOptionValues()) {
  const mode = values.timeRange;
  if (mode === "all") return null;
  if (mode === "custom") {
    const from = values.dateFrom;
    const to = values.dateTo;
    if (!from || !to) throw new Error("请填写自定义时间范围的开始和结束日期");
    const start = new Date(`${from}T00:00:00`).getTime();
    const end = new Date(`${to}T23:59:59.999`).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("自定义时间范围无效");
    return { start, end };
  }
  const days = Number.parseInt(mode, 10);
  return { start: Date.now() - days * 86400000, end: Date.now() };
}

function readIndexOptions(values = indexOptionValues()) {
  const readPages = (value, all) => {
    if (all) return null;
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error("页数必须是 1～10000 的整数，或勾选“全部”");
    return value;
  };
  return {
    boardPageLimit: readPages(values.boardPages, values.boardAll),
    threadPageLimit: readPages(values.threadPages, values.threadAll),
    timeRange: readIndexTimeRange(values),
    timeRangeMode: values.timeRange
  };
}

function inIndexTimeRange(value, range) {
  if (!range) return true;
  const time = parseForumTime(value);
  return time === null || (time >= range.start && time <= range.end);
}

function buildForumDocument(board, boardDescription, post, result, article) {
  const pos = Number(article.pos ?? article.position) || 0;
  const articleUser = article.poster || article.user;
  const postUser = post.poster || post.user;
  const author = articleUser?.id || articleUser || postUser?.id || postUser || "已注销";
  const authorName = articleUser?.user_name || articleUser?.username || "";
  const articleId = String(article.id ?? article.ID ?? article.article_id ?? "").trim();
  const gid = String(post.gid ?? post.group_id ?? post.id);
  return {
    id: pos === 0 ? `thread:${board}:${gid}` : `reply:${board}:${gid}:${pos}`,
    type: pos === 0 ? "thread" : "reply",
    board,
    boardDescription,
    gid,
    title: htmlToText(result.data?.title || post.title),
    content: htmlToText(article.content),
    contentFetched: true,
    author,
    authorName,
    articleId,
    pos,
    time: article.time ?? article.post_time ?? (pos === 0 ? postUpdatedTime(post) : null),
    replyCount: postReplyCount(post),
    url: threadUrl({ type: pos === 0 ? "thread" : "reply", board, gid, pos, articleId })
  };
}

function documentMatchesTerms(documentData, groups) {
  return Boolean(matchDocument(documentData, groups));
}

function scheduleOnlineRender() {
  if (state.onlineRenderTimer) return;
  state.onlineRenderTimer = window.setTimeout(() => {
    state.onlineRenderTimer = null;
    renderResults();
  }, 160);
}

function addOnlineDocument(documentData, groups) {
  if (!documentMatchesTerms(documentData, groups)) return;
  const exists = state.onlineDocumentMap.has(documentData.id);
  documentData = mergeDocument(state.onlineDocumentMap.get(documentData.id), documentData);
  state.onlineDocumentMap.set(documentData.id, documentData);
  if (exists) {
    const index = state.onlineDocuments.findIndex((item) => item.id === documentData.id);
    if (index >= 0) state.onlineDocuments[index] = documentData;
  } else {
    state.onlineDocuments.push(documentData);
  }
  updateOnlineSearchControls();
  scheduleOnlineRender();
}

function dropSessionPage(path) {
  const entry = state.sessionPages.get(path);
  if (!entry) return;
  state.sessionCacheBytes -= entry.bytes;
  state.sessionPages.delete(path);
}

function pruneSessionPages() {
  const cutoff = Date.now() - SESSION_CACHE_TTL_MS;
  state.sessionPages.forEach((entry, path) => { if (entry.fetchedAt <= cutoff) dropSessionPage(path); });
}

function rememberSessionPage(path, result) {
  pruneSessionPages();
  dropSessionPage(path);
  const bytes = new Blob([JSON.stringify(result)]).size;
  if (bytes > SESSION_CACHE_MAX_BYTES) return;
  while (state.sessionPages.size >= SESSION_CACHE_MAX_PAGES || state.sessionCacheBytes + bytes > SESSION_CACHE_MAX_BYTES) {
    dropSessionPage(state.sessionPages.keys().next().value);
  }
  state.sessionPages.set(path, { result, fetchedAt: Date.now(), bytes });
  state.sessionCacheBytes += bytes;
}

function getSessionPage(path, task) {
  const entry = state.sessionPages.get(path);
  if (!entry) return null;
  if (entry.fetchedAt <= Date.now() - SESSION_CACHE_TTL_MS) { dropSessionPage(path); return null; }
  if (task.options.threadPageLimit !== null && Number(new URL(path, "https://bbs.byr.cn").searchParams.get("page")) > task.options.threadPageLimit) return null;
  return entry;
}

function mergeOnlineDocuments(documents, groups) {
  documents.forEach((doc) => {
    const previous = state.onlineDocumentMap.get(doc.id);
    if (doc.cachePreview && previous?.contentFetched && !previous.cachePreview) return;
    if (previous?.fetchedAt > doc.fetchedAt) return;
    // 最新正文不再匹配时，移除此前显示的缓存命中或快速候选。
    if (!documentMatchesTerms(doc, groups)) {
      if (state.onlineDocumentMap.delete(doc.id)) state.onlineDocuments = state.onlineDocuments.filter((item) => item.id !== doc.id);
    } else addOnlineDocument(doc, groups);
  });
  scheduleOnlineRender();
}

function readArticleDocuments(board, post, result, range) {
  const articles = [
    ...(result.data?.head ? [{ ...result.data.head, pos: 0 }] : []),
    ...(result.data?.articles || result.data?.article || [])
  ];
  const documents = new Map();
  articles.forEach((article) => {
    const doc = buildForumDocument(board.name, board.description, post, result, article);
    if (inIndexTimeRange(doc.time, range)) documents.set(doc.id, doc);
  });
  return [...documents.values()];
}

function primeSessionResults(task) {
  pruneSessionPages();
  const groups = queryGroups(task.query);
  task.boards.forEach((board) => {
    const boardPrefix = `/n/b/board/${encodeURIComponent(board.name)}.json?page=`;
    const posts = new Map();
    state.sessionPages.forEach((entry, path) => {
      if (!path.startsWith(boardPrefix)) return;
      const page = Number(path.slice(boardPrefix.length));
      if (task.options.boardPageLimit !== null && page > task.options.boardPageLimit) return;
      boardPosts(entry.result.data).forEach((post) => posts.set(String(post.gid), post));
    });
    posts.forEach((post) => {
      const prefix = `/n/b/article/${encodeURIComponent(board.name)}/${encodeURIComponent(post.gid)}.json?page=`;
      state.sessionPages.forEach((_entry, path) => {
        if (!path.startsWith(prefix)) return;
        const cached = getSessionPage(path, task);
        if (cached) mergeOnlineDocuments(readArticleDocuments(board, post, cached.result, task.options.timeRange)
          .map((doc) => ({ ...doc, cachedAt: cached.fetchedAt, fetchedAt: cached.fetchedAt, cachePreview: true })), groups);
      });
    });
  });
}

function setOnlineSearchStatus(message, running = state.onlineSearchRunning) {
  const status = $("#online-search-status");
  status.hidden = state.searchMode !== "online";
  $("#online-search-status-summary").textContent = message || "尚未开始搜索 · 已找到 0 条";
  $("#online-search-status-details").textContent = message
    ? ""
    : "版面 0/0 · 主题页 0 · 内容页 0 · 主题 0 · 请求 0 次";
  status.classList.toggle("is-running", running);
}

function setSettingsOpen(open) {
  const dialog = $("#search-settings");
  const layout = $("#app-layout");
  const setBackgroundBlocked = (blocked) => {
    if (blocked) {
      if (!state.settingsBackgroundTargets.length) {
        const targets = [document.querySelector(".app-header"), ...[...layout.children].filter((item) => item !== dialog)].filter(Boolean);
        state.settingsBackgroundTargets = targets.map((element) => ({
          element,
          inert: Boolean(element.inert),
          ariaHidden: element.getAttribute("aria-hidden")
        }));
        state.settingsBackgroundTargets.forEach(({ element }) => {
          element.inert = true;
          element.setAttribute("aria-hidden", "true");
          element.classList.add("modal-background-blocked");
        });
      }
      if (!state.settingsGuardBound) {
        const preventBackgroundInteraction = (event) => {
          if (!dialog.open || dialog.contains(event.target)) return;
          if (event.type === "keydown" && event.key === "Escape") return;
          event.preventDefault();
          event.stopPropagation();
        };
        document.addEventListener("pointerdown", preventBackgroundInteraction, true);
        document.addEventListener("pointerup", preventBackgroundInteraction, true);
        document.addEventListener("mousedown", preventBackgroundInteraction, true);
        document.addEventListener("click", preventBackgroundInteraction, true);
        document.addEventListener("contextmenu", preventBackgroundInteraction, true);
        document.addEventListener("wheel", preventBackgroundInteraction, { capture: true, passive: false });
        document.addEventListener("touchmove", preventBackgroundInteraction, { capture: true, passive: false });
        document.addEventListener("focusin", preventBackgroundInteraction, true);
        document.addEventListener("keydown", preventBackgroundInteraction, true);
        state.settingsGuardBound = true;
      }
      if (!state.settingsScrollState) {
        state.settingsScrollState = {
          html: document.documentElement.style.overflow,
          body: document.body.style.overflow
        };
        document.documentElement.style.overflow = "hidden";
        document.body.style.overflow = "hidden";
      }
      return;
    }
    state.settingsBackgroundTargets.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
      element.classList.remove("modal-background-blocked");
    });
    state.settingsBackgroundTargets = [];
    if (state.settingsScrollState) {
      document.documentElement.style.overflow = state.settingsScrollState.html;
      document.body.style.overflow = state.settingsScrollState.body;
      state.settingsScrollState = null;
    }
  };
  if (open) {
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
    setBackgroundBlocked(true);
  } else {
    if (dialog.open) dialog.close();
    dialog.hidden = true;
    setBackgroundBlocked(false);
  }
}

function updateOnlineSearchControls() {
  const task = state.tasks.online;
  const online = state.searchMode === "online";
  const running = state.onlineSearchRunning;
  const paused = task?.phase === "paused";
  const failures = task?.jobs.filter((job) => job.status === "failed") || [];
  $("#online-search-tools").hidden = !online || (!task && !state.onlineDocuments.length);
  $("#pause-online").hidden = !running;
  $("#pause-online").disabled = Boolean(task?.pauseRequested);
  $("#pause-online").textContent = task?.pauseRequested ? "暂停中…" : "暂停";
  $("#continue-online").hidden = !paused || running;
  $("#continue-online").disabled = state.indexRunning;
  $("#retry-online").hidden = running || !failures.length;
  $("#retry-online").disabled = state.indexRunning;
  $("#retry-online").textContent = `重试失败项（${failures.length}）`;
  $("#new-online").hidden = !paused || running;
  $("#save-online-results").hidden = !state.onlineDocuments.length;
  $("#save-online-results").disabled = state.savingOnlineResults || state.indexRunning || !state.onlineDocuments.length;
  $("#search-button").disabled = online && (running || state.indexRunning);
  $("#search-button").textContent = online && paused ? "新搜索" : "搜索";
  $("#query-input").disabled = online && running;
  $("#search-mode-local").disabled = running;
  $("#search-mode-online").disabled = running;
  $("#fresh-online").hidden = !online;
  $("#fresh-online").disabled = running || state.indexRunning;
  $("#clear-index").disabled = running || state.indexRunning || state.savingOnlineResults;
  $("#retry-index").hidden = state.indexRunning || !state.tasks.index?.jobs.some((job) => job.status === "failed");
  $("#retry-index").disabled = running;
  $("#new-index").hidden = state.indexRunning || state.tasks.index?.phase !== "paused";
  $("#new-index").disabled = running;
  $("#full-index").disabled = state.indexRunning || state.onlineSearchRunning || state.boardListLoading || !state.selectedBoardNames.size;
  $("#pause-index").disabled = !state.indexRunning || Boolean(state.tasks.index?.pauseRequested);
  $("#pause-index").textContent = state.tasks.index?.pauseRequested && state.indexRunning ? "暂停中" : "暂停";
  updateIndexButtonState();
  renderScopePresets();
}

function updateTaskStatus(task, active = 0) {
  const metrics = ByrTasks.metrics(task);
  const labels = { running: task.pauseRequested ? "正在暂停" : "正在读取与搜索", paused: "已暂停，可继续", partial: "部分完成", complete: "所选范围扫描完成" };
  const phaseLabel = task.mode === "online" && state.restoredOnlineTaskId === task.id && !state.onlineSearchRunning
    ? "已恢复上次搜索"
    : labels[task.phase];
  const text = `${phaseLabel} · 版面 ${metrics.boards}/${metrics.boardTotal} · 已读取 ${metrics.boardPages} 个主题页、${metrics.contentPages} 个内容页 · 涉及 ${metrics.threads} 个主题 · 请求 ${task.requests} 次`
    + (task.mode === "online" ? ` · 原生搜索 ${metrics.nativePages} 页` : "")
    + (task.mode === "online" ? ` · 命中 ${state.onlineDocuments.length} 条` : "")
    + (task.mode === "index" && task.incrementalSkipped ? ` · 跳过 ${task.incrementalSkipped} 个未变化主题` : "")
    + (task.cachePages ? ` · 复用 ${task.cachePages} 个内容页（${formatTime(task.cacheOldestAt)} 获取）` : "")
    + (metrics.failures.length ? ` · 失败 ${metrics.failures.length} 项` : "")
    + (task.error ? ` · ${task.error}` : "");
  const compact = task.mode === "online"
    ? `${phaseLabel} · 已找到 ${state.onlineDocuments.length} 条`
    : `${labels[task.phase]} · 版面 ${metrics.boards}/${metrics.boardTotal}`;
  if (task.mode === "online") {
    state.onlineActiveWorkers = active;
    $("#online-search-status-summary").textContent = compact;
    $("#online-search-status-details").textContent = text;
    $("#online-search-status").hidden = state.searchMode !== "online";
    $("#online-search-status").classList.toggle("is-running", task.phase === "running");
  } else {
    state.indexActiveWorkers = active;
    $("#index-status-summary").textContent = compact;
    $("#index-status-details").textContent = text;
    if (task.phase === "complete") $("#index-progress").style.width = "100%";
  }
  const failedJobs = Object.values(state.tasks).filter(Boolean).flatMap((item) =>
    item.jobs.filter((job) => job.status === "failed").map((job) => ({ ...job, mode: item.mode }))
  );
  $("#task-failures").hidden = !failedJobs.length;
  $("#task-failures-summary").textContent = `失败任务（${failedJobs.length}）`;
  $("#task-failures-list").innerHTML = failedJobs.map((job) =>
    `<p>${job.mode === "online" ? "在线搜索" : "本地更新"} · ${escapeHtml(job.board.description)} · ${job.kind === "native" ? "论坛快速搜索" : job.kind === "board" ? "主题列表" : `主题 ${escapeHtml(job.post.gid)}`} 第 ${job.page || 1} 页：${escapeHtml(job.error)}</p>`
  ).join("");
  updateOnlineSearchControls();
  updatePerformanceLiveStatus();
}

function nativeSearchDays(timeRange) {
  if (!timeRange) return 0;
  return Math.max(1, Math.ceil((Date.now() - timeRange.start) / 86400000));
}

function nativeSearchValue(value) {
  return encodeURIComponent(encodeURIComponent(String(value || "")));
}

function nativeSearchPaths(boardName, query, options) {
  const groups = queryGroups(query);
  const common = `b=${nativeSearchValue(boardName)}&d=${nativeSearchDays(options.timeRange)}`;
  return [...new Set(groups.flatMap((terms) => {
    const titleTerms = [`t1=${nativeSearchValue(terms[0])}`];
    if (terms[1]) titleTerms.push(`t2=${nativeSearchValue(terms[1])}`);
    const paths = [`/s/article?${common}&${titleTerms.join("&")}`];
    if (terms.length === 1 && /^[a-z][a-z0-9_]{1,19}$/u.test(terms[0])) paths.push(`/s/article?${common}&au=${nativeSearchValue(terms[0])}`);
    return paths;
  }))];
}

function nativeResultTime(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (/^\d{2}:\d{2}:\d{2}$/u.test(text)) return `${dateInputValue(new Date())} ${text}`;
  return text;
}

function parseNativeSearchPage(html, fallbackBoard, groups, path, pageLimit) {
  const documentNode = new DOMParser().parseFromString(String(html || ""), "text/html");
  const results = [];
  documentNode.querySelectorAll(".board-list tr").forEach((row) => {
    const cells = row.querySelectorAll("td");
    const link = cells[1]?.querySelector('a[href*="/article/"]');
    const match = link?.getAttribute("href")?.match(/\/article\/([^/?#]+)\/(\d+)/u);
    if (!match) return;
    const boardName = decodeURIComponent(match[1]);
    const gid = match[2];
    const author = cells[3]?.querySelector("a")?.textContent?.trim() || "";
    const documentData = {
      id: `thread:${boardName}:${gid}`,
      type: "thread",
      board: boardName,
      boardDescription: fallbackBoard.description,
      gid,
      title: link.textContent.trim(),
      content: "",
      author,
      authorName: "",
      pos: 0,
      time: nativeResultTime(cells[2]?.textContent),
      replyCount: Number.parseInt(cells[4]?.textContent, 10) || 0,
      nativeSearch: true,
      url: threadUrl({ type: "thread", board: boardName, gid })
    };
    if (documentMatchesTerms(documentData, groups)) results.push(documentData);
  });
  const currentUrl = new URL(path, "https://bbs.byr.cn");
  const page = Number(currentUrl.searchParams.get("p")) || 1;
  let nextPath = null;
  if (pageLimit === null || page < pageLimit) {
    const queryKey = (url) => JSON.stringify([...url.searchParams].filter(([key]) => key !== "p").sort());
    const expectedQuery = queryKey(currentUrl);
    const hasNext = [...documentNode.querySelectorAll(".pagination a[href]")].some((link) => {
      const url = new URL(link.getAttribute("href"), currentUrl);
      return url.origin === currentUrl.origin && url.pathname === currentUrl.pathname
        && Number(url.searchParams.get("p")) === page + 1 && queryKey(url) === expectedQuery;
    });
    if (hasNext) {
      // 沿用原请求的查询条件，只修改页码，不直接请求页面中任意链接。
      currentUrl.searchParams.set("p", String(page + 1));
      nextPath = `${currentUrl.pathname}${currentUrl.search}`;
    }
  }
  return { documents: results, nextPath };
}

function queueCheckpoint() {
  if (state.checkpointTimer) return;
  state.checkpointTimer = window.setTimeout(() => {
    state.checkpointTimer = null;
    persistTasks().catch((error) => {
      if (!state.checkpointError) showToast("进度保存失败；请保持页面打开：" + error.message);
      state.checkpointError = error.message;
    });
  }, 500);
}

function persistTasks() {
  window.clearTimeout(state.checkpointTimer);
  state.checkpointTimer = null;
  const snapshots = Object.values(state.tasks).filter(Boolean).map((task) => ({
    ...ByrTasks.snapshot(task),
    results: task.mode === "online" ? structuredClone(state.onlineDocuments) : []
  }));
  const writing = state.checkpointWrites.catch(() => {}).then(() => putMany("tasks", snapshots));
  state.checkpointWrites = writing;
  return writing;
}

async function restoreTasks() {
  const tasks = await getAll("tasks");
  let restoredOnlineResults = false;
  tasks.forEach((task) => {
    if (!["online", "index"].includes(task.mode) || !Array.isArray(task.jobs)) return;
    task.jobs.forEach((job) => { if (job.status === "running") job.status = "pending"; });
    if (task.phase === "running") task.phase = "paused";
    task.pauseRequested = false;
    state.tasks[task.mode] = task;
    if (task.mode === "online") {
      state.onlineDocuments = task.results || [];
      state.onlineDocumentMap = new Map(state.onlineDocuments.map((doc) => [doc.id, doc]));
      state.onlineQuery = task.query;
      $("#query-input").value = task.query;
      state.restoredOnlineTaskId = task.id || "";
      restoredOnlineResults = true;
    }
    delete task.results;
    updateTaskStatus(task);
  });
  // 任务状态恢复后，初始化阶段的空结果视图也要同步到已恢复的关键词和结果。
  if (restoredOnlineResults) renderResults();
}

function enqueuePage(task, kind, board, page = 1, post = null) {
  ByrTasks.enqueue(task, { kind, board, page, ...(post ? { post } : {}) });
  if (kind !== "article" || task.mode !== "online") return;
  const path = `/n/b/article/${encodeURIComponent(board.name)}/${encodeURIComponent(post.gid)}.json?page=${page}`;
  const cached = getSessionPage(path, task);
  if (cached) mergeOnlineDocuments(readArticleDocuments(board, post, cached.result, task.options.timeRange)
    .map((doc) => ({ ...doc, cachedAt: cached.fetchedAt, fetchedAt: cached.fetchedAt, cachePreview: true })), queryGroups(task.query));
}

async function executeTaskJob(task, job) {
  checkTaskCancelled(task);
  const groups = queryGroups(task.query);
  const { board, post, page } = job;
  if (job.kind === "native") {
    const html = await requestForumText(job.path, task);
    const nativePage = parseNativeSearchPage(html, board, groups, job.path, task.options.boardPageLimit);
    if (nativePage.nextPath) ByrTasks.enqueue(task, { kind: "native", board, path: nativePage.nextPath, page: page + 1 });
    const results = nativePage.documents
      .filter((doc) => inIndexTimeRange(doc.time, task.options.timeRange));
    results.forEach((doc) => {
      addOnlineDocument(doc, groups);
      // 原生搜索找到的历史主题也读取正文，补全快速候选。
      enqueuePage(task, "article", board, 1, { gid: doc.gid, title: doc.title, poster: doc.author, time: doc.time });
    });
    return;
  }
  const path = job.kind === "board"
    ? `/n/b/board/${encodeURIComponent(board.name)}.json?page=${page}`
    : `/n/b/article/${encodeURIComponent(board.name)}/${encodeURIComponent(post.gid)}.json?page=${page}`;
  const cached = job.kind === "article" && task.mode === "online" ? getSessionPage(path, task) : null;
  const result = cached?.result || await requestApi(path, task);
  if (cached) {
    task.cachePages = (task.cachePages || 0) + 1;
    task.cacheOldestAt = Math.min(task.cacheOldestAt || cached.fetchedAt, cached.fetchedAt);
  } else rememberSessionPage(path, result);
  const total = Math.max(1, Number(result.data?.pagination?.total) || 1);
  const limit = job.kind === "board" ? task.options.boardPageLimit : task.options.threadPageLimit;
  const pageLimit = limit === null ? total : Math.min(total, limit);
  if (page < pageLimit) enqueuePage(task, job.kind, board, page + 1, post);
  if (job.kind === "board") {
    boardPosts(result.data).forEach((item) => {
      if (shouldReadIndexedPost(task, board, item)) enqueuePage(task, "article", board, 1, item);
      else task.incrementalSkipped = (task.incrementalSkipped || 0) + 1;
    });
    return;
  }
  const fetchedAt = cached?.fetchedAt || Date.now();
  const documents = readArticleDocuments(board, post, result, task.options.timeRange)
    .map((doc) => ({ ...doc, cachedAt: cached?.fetchedAt || null, fetchedAt, cachePreview: false }));
  if (task.mode === "online") {
    mergeOnlineDocuments(documents, groups);
  } else {
    try {
      await saveDocuments(documents);
    } catch (error) {
      error.fatal = true;
      throw error;
    }
    documents.forEach((doc) => {
      const index = state.documents.findIndex((item) => item.id === doc.id);
      if (index < 0) state.documents.push(doc);
      else state.documents[index] = mergeDocument(state.documents[index], doc);
    });
    if (page >= pageLimit) rememberIndexedPost(task, board, post);
    scheduleOnlineRender();
  }
}

async function runTask(task) {
  if (state.indexRunning || state.onlineSearchRunning) return;
  if (task.mode === "online" && state.restoredOnlineTaskId === task.id) state.restoredOnlineTaskId = "";
  if (task.mode === "online") {
    state.onlineSearchRunning = true;
    $("#query-input").value = task.query;
    state.onlineQuery = task.query;
    setSearchMode("online");
  } else {
    state.indexRunning = true;
    setIndexStatus("开始读取所选范围", 0);
  }
  try {
    await persistTasks();
    await ByrTasks.run(task, (job) => executeTaskJob(task, job), () => state.requestConcurrency,
      (active) => { updateTaskStatus(task, active); queueCheckpoint(); }, state.queueSchedulers);
    if (task.mode === "online" && task.phase === "complete") {
      // 预览的旧目录可能已变化；完成后只保留本次实际扫描确认过的内容。
      state.onlineDocuments = state.onlineDocuments.filter((doc) => !doc.cachePreview);
      state.onlineDocumentMap = new Map(state.onlineDocuments.map((doc) => [doc.id, doc]));
    }
    await persistTasks();
    state.checkpointError = "";
  } catch (error) {
    task.phase = "paused";
    task.error = "任务暂停：" + (error.message || "无法保存进度");
  } finally {
    state.onlineSearchRunning = false;
    state.indexRunning = false;
    state.onlineActiveWorkers = 0;
    state.indexActiveWorkers = 0;
    updateTaskStatus(task);
    renderResults();
    await refreshResourceUsage();
  }
}

async function startNewTask(mode, fresh = false, overrides = {}) {
  if (state.indexRunning || state.onlineSearchRunning) return;
  const query = mode === "online" ? $("#query-input").value.trim() : "";
  if (mode === "online" && !query) { showToast("请输入搜索关键词"); return; }
  if (mode === "online" && !queryGroups(query).length) { showToast("OR 两侧都需要填写关键词，例如：关键词1 OR 关键词2"); return; }
  if (mode === "online") rememberSearch(query, mode);
  const previous = state.tasks[mode];
  if (previous?.phase === "paused" && !window.confirm("开始新任务会替换当前暂停任务的进度，已保存的本地内容会保留。继续吗？")) return;
  try {
    if (!state.boards.length) await loadBoards();
    const names = resolveBoardNames([...state.selectedBoardNames]);
    if (!names.length) { $("#manual-board-details").open = true; $("#settings-range-panel").scrollIntoView({ block: "nearest" }); throw new Error("请选择至少一个版面"); }
    const boards = state.boards.filter((board) => names.includes(board.name));
    const task = ByrTasks.create(mode, boards, { ...readIndexOptions(), ...overrides }, query);
    if (mode === "index") task.incrementalSkipped = 0;
    if (fresh) { state.sessionPages.clear(); state.sessionCacheBytes = 0; }
    boards.forEach((board) => {
      if (mode === "online") nativeSearchPaths(board.name, query, task.options).forEach((path) => {
        ByrTasks.enqueue(task, { kind: "native", board, path, page: 1 });
      });
      enqueuePage(task, "board", board);
    });
    state.tasks[mode] = task;
    if (mode === "online") {
      state.onlineDocuments = [];
      state.onlineDocumentMap.clear();
      state.onlineQuery = query;
      primeSessionResults(task);
    }
    await runTask(task);
  } catch (error) {
    showToast(error.message || "无法开始任务");
  }
}

function pauseTask(mode) {
  const task = state.tasks[mode];
  if (!task || task.phase !== "running") return;
  task.pauseRequested = true;
  updateTaskStatus(task);
  state.queueSchedulers.forEach((schedule) => schedule());
}

async function continueTask(mode, retry = false) {
  if (state.indexRunning || state.onlineSearchRunning) return;
  const task = state.tasks[mode];
  if (!task) return;
  if (retry) task.jobs.forEach((job) => {
    if (job.status === "failed") { job.status = "pending"; delete job.error; }
  });
  await runTask(task);
}

function startIndex() {
  return state.tasks.index?.phase === "paused" ? continueTask("index") : startNewTask("index");
}

function startFullIndex() {
  return startNewTask("index", false, { incremental: false });
}

function pauseIndex() {
  pauseTask("index");
}

function setSearchMode(mode) {
  const online = mode === "online";
  if (state.onlineSearchRunning && !online) { showToast("请先暂停搜索"); return; }
  state.searchMode = online ? "online" : "local";
  $("#search-mode-local").classList.toggle("is-active", !online);
  $("#search-mode-online").classList.toggle("is-active", online);
  $("#search-mode-local").setAttribute("aria-selected", String(!online));
  $("#search-mode-online").setAttribute("aria-selected", String(online));
  $("#search-mode-description").textContent = online ? "边读取边搜索，结果陆续显示" : "搜索已保存的内容，无需联网";
  $("#online-search-status").hidden = !online;
  if (online) {
    if (state.tasks.online) updateTaskStatus(state.tasks.online, state.onlineActiveWorkers);
    else setOnlineSearchStatus("", false);
  }
  updateOnlineSearchControls();
  renderResults();
}

function startOnlineSearch() {
  return startNewTask("online");
}

function matchDocument(documentData, groups) {
  if (!groups.length) return null;
  // 回帖只匹配自身正文和作者，主题标题、版面信息只是上下文。
  const keys = documentData.type === "reply" ? ["content", "author", "authorName"]
    : ["title", "content", "author", "authorName", "board", "boardDescription"];
  const fields = keys.map((key) => [key, String(documentData[key] || "").toLocaleLowerCase()]);
  const text = fields.map(([, value]) => value).join(" ");
  const terms = matchingTerms(text, groups);
  if (!terms.length) return null;
  const weights = { title: 8, content: 4, author: 7, authorName: 7, board: 2, boardDescription: 2 };
  let score = 0;
  const matchedFields = [];
  fields.forEach(([key, value]) => {
    const count = terms.filter((term) => value.includes(term)).length;
    if (count) { matchedFields.push(key); score += weights[key] * count; }
  });
  return { score, matchedFields, terms };
}

function compareResults(a, b) {
  if (state.sort === "recent") {
    const aTime = parseForumTime(a.latestTime ?? a.user?.latest ?? a.documentData?.time) ?? -Infinity;
    const bTime = parseForumTime(b.latestTime ?? b.user?.latest ?? b.documentData?.time) ?? -Infinity;
    if (aTime !== bTime) return bTime - aTime;
  }
  return b.score - a.score;
}

function groupDocumentResults(results) {
  const groups = new Map();
  results.forEach((result) => {
    const documentData = result.documentData;
    const key = `${documentData.board}:${documentData.gid}`;
    const group = groups.get(key) || { key, parentResult: null, replies: [] };
    if (documentData.type === "thread") group.parentResult = result;
    else group.replies.push(result);
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => {
    const first = group.replies[0]?.documentData;
    const parentResult = group.parentResult || (first ? {
      documentData: {
        ...first,
        id: `thread:${first.board}:${first.gid}`,
        type: "thread",
        pos: 0,
        author: "",
        authorName: "",
        content: "",
        nativeSearch: false,
        url: threadUrl({ type: "thread", board: first.board, gid: first.gid })
      },
      score: Math.max(...group.replies.map((item) => item.score), 0),
      matchedFields: [],
      terms: [...new Set(group.replies.flatMap((item) => item.terms || []))]
    } : null);
    const latestTime = [...(group.parentResult ? [group.parentResult.documentData.time] : []), ...group.replies.map((item) => item.documentData.time)]
      .map(parseForumTime).filter((value) => value !== null).sort((a, b) => b - a)[0] || null;
    return {
      resultType: "thread-group",
      documentData: parentResult.documentData,
      parentResult,
      replies: group.replies.sort(compareResults),
      score: parentResult.score,
      latestTime,
      directHit: Boolean(group.parentResult)
    };
  }).filter((group) => group.parentResult).sort(compareResults);
}

function searchSourceDocuments() {
  if (state.searchMode === "online") return state.onlineDocuments;
  const boards = state.selectedBoardNames;
  try {
    const range = readIndexTimeRange();
    return state.documents.filter((doc) => boards.has(doc.board) && inIndexTimeRange(doc.time, range));
  } catch (_error) {
    return [];
  }
}

function searchDocuments(query) {
  const groups = queryGroups(query);
  if (!groups.length) return [];
  const source = searchSourceDocuments();
  const candidates = source.filter((documentData) => state.activeType === "all" || documentData.type === state.activeType);
  return candidates.map((documentData) => {
    const match = matchDocument(documentData, groups);
    return match ? { documentData, ...match } : null;
  }).filter(Boolean).sort(compareResults);
}

function boardResults(query) {
  const groups = queryGroups(query);
  const terms = termsFromQuery(query);
  if (!terms.length) return [];
  return state.boards.filter((board) => {
    if (state.searchMode === "local" && !state.selectedBoardNames.has(board.name)) return false;
    const fields = `${board.name} ${board.description}`.toLocaleLowerCase();
    return matchingTerms(fields, groups).length > 0;
  }).map((board) => ({
    documentData: {
      id: `board:${board.name}`,
      type: "board",
      board: board.name,
      boardDescription: board.description,
      title: board.name,
      content: board.description
    },
    score: 2,
    terms
  }));
}

function userResults(query) {
  const groups = queryGroups(query);
  const terms = termsFromQuery(query);
  if (!terms.length) return [];
  const users = new Map();
  const source = searchSourceDocuments();
  source.forEach((documentData) => {
    const id = documentData.author || "";
    const name = documentData.authorName || "";
    const fields = `${id} ${name}`.toLocaleLowerCase();
    if (!id || !matchingTerms(fields, groups).length) return;
    const current = users.get(id) || { id, name, count: 0, latest: documentData.time, board: documentData.board, documentData };
    current.count += 1;
    if ((parseForumTime(documentData.time) ?? -Infinity) > (parseForumTime(current.latest) ?? -Infinity)) current.latest = documentData.time;
    users.set(id, current);
  });
  return [...users.values()].map((user) => ({ user, score: user.count, terms })).sort(compareResults);
}

function renderDocumentResult(result) {
  const { documentData, terms, matchedFields = [] } = result;
  const title = documentData.type === "reply" ? `第 ${documentData.pos || 0} 楼回帖` : documentData.title || "无标题";
  const location = documentData.type === "reply" ? `第 ${documentData.pos || 0} 楼` : "主题帖";
  const labels = { title: "标题", content: "正文", author: "作者", authorName: "作者", board: "版面", boardDescription: "版面" };
  const matched = documentData.type === "reply"
    ? (matchedFields.length ? "回帖" : "")
    : [...new Set(matchedFields.map((key) => labels[key]))].join("、");
  return `<article class="result-card">
    <a class="result-card-link" href="${escapeHtml(threadUrl(documentData, terms))}" target="_blank" rel="noreferrer">
    <h3 class="result-title">${highlight(title, terms)}</h3>
    <div class="result-meta"><span class="result-kind">${documentData.type === "reply" ? "回帖" : "帖子"}</span><span>${escapeHtml(documentData.boardDescription || documentData.board)}</span><span>${escapeHtml(documentData.author || "已注销")}</span><span>${escapeHtml(location)}</span><span>${escapeHtml(formatTime(documentData.time))}</span>${matched ? `<span>命中：${matched}</span>` : ""}${documentData.nativeSearch ? '<span class="result-source">论坛快速匹配</span>' : ""}</div>
    ${state.searchMode === "online" && documentData.cachedAt ? `<p class="field-help">${documentData.cachePreview ? "缓存预览" : "缓存内容"} · ${escapeHtml(formatTime(documentData.cachedAt))} 获取</p>` : ""}
    ${documentData.content ? `<p class="result-snippet">${highlight(getSnippet(documentData.content, terms), terms)}</p>` : ""}
    <div class="result-foot"><span>主题编号 ${escapeHtml(documentData.gid)}</span><span class="result-link-hint">${documentData.type === "reply" ? "跳到此楼" : "打开原文"} ↗</span></div>
    </a>
  </article>`;
}

function renderMatchedReply(result) {
  const { documentData, terms } = result;
  return `<a class="result-child" href="${escapeHtml(threadUrl(documentData, terms))}" target="_blank" rel="noreferrer">
    <div class="result-child-meta"><span class="result-kind">回帖</span><span>${highlight(documentData.author || "已注销", terms)}</span><span>第 ${escapeHtml(documentData.pos || 0)} 楼</span><span>${escapeHtml(formatTime(documentData.time))}</span><span>命中：回帖</span><span class="result-link-hint">跳到此楼 ↗</span></div>
    ${documentData.content ? `<p class="result-snippet">${highlight(getSnippet(documentData.content, terms), terms)}</p>` : ""}
  </a>`;
}

function renderThreadGroup(group) {
  const parent = group.parentResult;
  const documentData = parent.documentData;
  const labels = { title: "标题", content: "正文", author: "作者", authorName: "作者", board: "版面", boardDescription: "版面" };
  const matched = [...new Set((parent.matchedFields || []).map((key) => labels[key]).filter(Boolean))].join("、");
  const replies = group.replies || [];
  const visible = replies.slice(0, 2);
  const extra = replies.slice(2);
  const matchedParts = [matched, replies.length ? "回帖" : ""].filter(Boolean);
  const matchSummary = matchedParts.length ? `命中：${matchedParts.join("、")}` : "";
  const childHtml = visible.map(renderMatchedReply).join("")
    + (extra.length ? `<details class="result-child-more"><summary>还有 ${extra.length} 条回帖命中</summary>${extra.map(renderMatchedReply).join("")}</details>` : "");
  return `<article class="result-card result-group">
    <a class="result-group-main" href="${escapeHtml(threadUrl(documentData, parent.terms || []))}" target="_blank" rel="noreferrer">
    <h3 class="result-title">${highlight(documentData.title || "无标题", parent.terms || [])}</h3>
    <div class="result-meta"><span class="result-kind">帖子</span><span>${escapeHtml(documentData.boardDescription || documentData.board)}</span>${documentData.author ? `<span>${escapeHtml(documentData.author)}</span>` : ""}<span>${escapeHtml(formatTime(documentData.time))}</span><span>${escapeHtml(matchSummary)}</span>${documentData.nativeSearch ? '<span class="result-source">论坛快速匹配</span>' : ""}</div>
    ${state.searchMode === "online" && documentData.cachedAt ? `<p class="field-help">${documentData.cachePreview ? "缓存预览" : "缓存内容"} · ${escapeHtml(formatTime(documentData.cachedAt))} 获取</p>` : ""}
    ${documentData.content ? `<p class="result-snippet">${highlight(getSnippet(documentData.content, parent.terms || []), parent.terms || [])}</p>` : ""}
    <span class="result-link-hint">打开原文 ↗</span>
    </a>
    ${replies.length ? `<div class="result-children">${childHtml}</div>` : ""}
  </article>`;
}

function renderUserResult(result) {
  const { user, terms } = result;
  const sourceLabel = state.searchMode === "online" ? "条本次扫描内容" : "条已索引内容";
  return `<article class="result-card">
    <h3 class="result-title"><a href="${escapeHtml(userUrl(user.id))}" target="_blank" rel="noreferrer">${highlight(user.id, terms)}</a></h3>
    <div class="result-meta"><span class="result-kind">用户</span><span>${escapeHtml(user.name || "未设置昵称")}</span><span>${user.count} ${sourceLabel}</span><span>${escapeHtml(formatTime(user.latest))}</span></div>
    <div class="result-foot"><span>常见版面：${escapeHtml(user.board || "未知")}</span><a href="${escapeHtml(userUrl(user.id))}" target="_blank" rel="noreferrer">打开用户主页 ↗</a></div>
  </article>`;
}

function renderBoardResult(result) {
  const { documentData, terms } = result;
  return `<article class="result-card">
    <h3 class="result-title"><a href="${escapeHtml(boardUrl(documentData.board))}" target="_blank" rel="noreferrer">${highlight(documentData.board, terms)}</a></h3>
    <div class="result-meta"><span class="result-kind">版面</span><span>${escapeHtml(documentData.boardDescription || "")}</span></div>
    <div class="result-foot"><span>版面来自论坛公开列表</span><a href="${escapeHtml(boardUrl(documentData.board))}" target="_blank" rel="noreferrer">打开版面 ↗</a></div>
  </article>`;
}

function renderResults() {
  const query = state.searchMode === "online" && state.onlineQuery ? state.onlineQuery : $("#query-input").value;
  const list = $("#result-list");
  if (!query.trim()) {
    const sourceCount = searchSourceDocuments().length;
    $("#result-count").textContent = sourceCount ? `当前有 ${sourceCount} 条内容` : "输入关键词开始搜索";
    list.innerHTML = `<div class="empty-state"><strong>输入关键词开始搜索</strong><p>${state.searchMode === "online" ? "点击搜索后会扫描当前选择的版面范围。" : "结果会在当前浏览器本地完成匹配。"}</p></div>`;
    return;
  }
  if (!queryGroups(query).length) {
    $("#result-count").textContent = "请检查关键词";
    list.innerHTML = '<div class="empty-state"><strong>OR 两侧都需要关键词</strong><p>例如：关键词1 OR 关键词2</p></div>';
    return;
  }
  let results;
  if (state.activeType === "user") {
    results = userResults(query);
  } else if (state.activeType === "board") {
    results = boardResults(query);
  } else if (state.activeType === "all") {
    const documents = searchDocuments(query).filter((result) => result.documentData.type !== "board");
    const groups = groupDocumentResults(documents);
    const users = userResults(query).slice(0, 20).map((result) => ({ ...result, resultType: "user" }));
    const boards = boardResults(query).slice(0, 20).map((result) => ({ ...result, resultType: "board" }));
    results = [...groups, ...users, ...boards];
    results.documentHitCount = documents.length;
    results.topicCount = groups.length;
  } else {
    results = searchDocuments(query);
    if (state.activeType === "thread") results = groupDocumentResults(results);
  }
  results.sort(compareResults);
  const hitCount = results.documentHitCount ?? (state.activeType === "reply" ? results.length : results.length);
  const topicCount = results.topicCount ?? (state.activeType === "thread" ? results.length : null);
  $("#result-count").textContent = topicCount !== null
    ? `找到 ${hitCount} 条命中 · 涉及 ${topicCount} 个主题${hitCount > 200 ? " · 显示前 200 条主题" : ""}`
    : `找到 ${hitCount} 条结果${hitCount > 200 ? " · 显示前 200 条" : ""}`;
  if (!results.length) {
    const message = state.searchMode === "online" && state.onlineSearchRunning
      ? "正在扫描，匹配结果会陆续显示。"
      : "可以换一个关键词，或扩大版面和历史范围。";
    list.innerHTML = `<div class="empty-state"><strong>没有找到匹配内容</strong><p>${message}</p></div>`;
    return;
  }
  list.innerHTML = results.slice(0, 200).map((result) => {
    const type = result.resultType || state.activeType;
    if (type === "thread-group") return renderThreadGroup(result);
    if (type === "user") return renderUserResult(result);
    if (type === "board") return renderBoardResult(result);
    return renderDocumentResult(result);
  }).join("");
}

async function saveOnlineResults() {
  if (state.savingOnlineResults || state.indexRunning) return;
  if (!state.onlineDocuments.length) {
    showToast("当前没有可保存的在线结果");
    return;
  }
  const documents = structuredClone(state.onlineDocuments);
  state.savingOnlineResults = true;
  const button = $("#save-online-results");
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await saveDocuments(documents);
    state.documents = await getAll("documents");
    await refreshResourceUsage();
    showToast(`已保存 ${documents.length} 条在线结果到本地索引`);
  } catch (error) {
    showToast(error.message || "保存在线结果失败");
  } finally {
    state.savingOnlineResults = false;
    button.textContent = "保存结果";
    updateOnlineSearchControls();
  }
}

async function loadDocuments() {
  state.documents = await getAll("documents");
  if (!state.tasks.index && state.documents.length) setIndexStatus(`本地已有 ${state.documents.length} 条内容，更新会保留历史`, 0);
  state.boards = uniqueBoards((await getAll("boards")).map((board) => {
    const nameLooksChinese = /[\u3400-\u9fff]/u.test(String(board.name || ""));
    const descriptionLooksLikeId = /^[A-Za-z][A-Za-z0-9_]*$/u.test(String(board.description || ""));
    return nameLooksChinese && descriptionLooksLikeId
      ? { name: board.description, description: board.name }
      : board;
  }));
  if (state.boards.length) {
    state.boardListReady = true;
    if (!state.boardTree.length) state.boardTree = cachedBoardTree(state.boards);
    renderBoardOptions();
  }
  renderResults();
  await refreshResourceUsage();
}

async function clearIndex() {
  if (state.indexRunning || state.onlineSearchRunning || state.savingOnlineResults) return;
  if (!window.confirm("确定清空当前浏览器中的本地索引吗？")) return;
  await clearStore("documents");
  state.documents = [];
  setIndexStatus("本地索引已清空", 0);
  renderResults();
  await refreshResourceUsage();
  updateOnlineSearchControls();
  showToast("本地索引已清空");
}

function bindEvents() {
  $("#fresh-online").addEventListener("click", () => startNewTask("online", true));
  $("#open-settings").addEventListener("click", () => setSettingsOpen(true));
  $("#close-settings").addEventListener("click", () => setSettingsOpen(false));
  $("#search-settings").addEventListener("cancel", (event) => { event.preventDefault(); setSettingsOpen(false); });
  $("#save-scope-preset").addEventListener("click", saveScopePreset);
  $("#delete-scope-preset").addEventListener("click", deleteScopePreset);
  $("#scope-preset-name").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveScopePreset(); } });
  $("#new-scope-preset").addEventListener("click", () => {
    state.editingScopeId = "current";
    $("#scope-preset-name").value = "";
    $("#scope-preset-feedback").textContent = "沿用当前勾选和读取范围，调整后填写名称保存。";
    $("#manual-board-details").open = true;
    renderScopePresets();
    $("#scope-preset-name").focus();
  });
  $("#pause-online").addEventListener("click", () => pauseTask("online"));
  $("#continue-online").addEventListener("click", () => continueTask("online"));
  $("#retry-online").addEventListener("click", () => continueTask("online", true));
  $("#new-online").addEventListener("click", startOnlineSearch);
  $("#retry-index").addEventListener("click", () => continueTask("index", true));
  $("#new-index").addEventListener("click", () => startNewTask("index"));
  $("#full-index").addEventListener("click", startFullIndex);
  $("#refresh-boards").addEventListener("click", () => loadBoards(true).catch((error) => showToast(error.message)));
  $("#select-all-boards").addEventListener("click", () => {
    setBoardSelection(state.boards.map((board) => board.name));
    showToast(state.boards.length ? `已选择全部 ${state.boards.length} 个版面` : "尚未读取到可用版面");
  });
  $("#clear-board-selection").addEventListener("click", () => {
    setBoardSelection([]);
    showToast("已清空版面选择");
  });
  $("#board-mode-select").addEventListener("click", () => setBoardPickerMode("select"));
  $("#board-mode-review").addEventListener("click", () => setBoardPickerMode("review"));
  $("#board-filter").addEventListener("input", (event) => {
    state.boardFilter = event.target.value;
    renderFlatBoardList();
  });
  $("#board-search").addEventListener("input", (event) => {
    state.boardSearch = event.target.value;
    state.boardSearchActiveIndex = -1;
    renderBoardSearchResults();
  });
  $("#board-search").addEventListener("keydown", (event) => {
    const boards = boardSearchMatches();
    if (event.key === "Escape") {
      event.preventDefault();
      $("#board-search").value = "";
      state.boardSearch = "";
      state.boardSearchActiveIndex = -1;
      renderBoardSearchResults();
      return;
    }
    if (!boards.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowDown") state.boardSearchActiveIndex = (state.boardSearchActiveIndex + 1) % boards.length;
    if (event.key === "ArrowUp") state.boardSearchActiveIndex = (state.boardSearchActiveIndex - 1 + boards.length) % boards.length;
    if (event.key === "Enter") {
      const board = boards[Math.max(0, state.boardSearchActiveIndex)];
      if (board) toggleBoardSelection(board.name);
    }
    renderBoardSearchResults();
  });
  $("#index-board-all").addEventListener("change", (event) => { $("#index-board-pages").disabled = event.target.checked; updateIndexRangeSummary(); });
  $("#index-thread-all").addEventListener("change", (event) => { $("#index-thread-pages").disabled = event.target.checked; updateIndexRangeSummary(); });
  $("#index-board-pages").addEventListener("input", updateIndexRangeSummary);
  $("#index-thread-pages").addEventListener("input", updateIndexRangeSummary);
  $("#index-time-range").addEventListener("change", (event) => {
    if (event.target.value === "custom" && (!$("#index-date-from").value || !$("#index-date-to").value)) setDefaultCustomDates();
    $("#index-custom-dates").hidden = event.target.value !== "custom";
    updateIndexRangeSummary();
  });
  $("#index-date-from").addEventListener("change", updateIndexRangeSummary);
  $("#index-date-to").addEventListener("change", updateIndexRangeSummary);
  $("#request-speed").addEventListener("change", (event) => {
    state.requestPreset = event.target.value;
    if (state.requestPreset !== "custom") {
      state.requestConcurrency = PERFORMANCE_PRESETS[state.requestPreset].concurrency;
      state.requestDelayMs = PERFORMANCE_PRESETS[state.requestPreset].delayMs;
      $("#request-concurrency").value = String(state.requestConcurrency);
      $("#request-delay").value = String(state.requestDelayMs);
    }
    updatePerformanceConfig();
  });
  const markCustomPerformance = () => {
    $("#request-speed").value = "custom";
    state.requestPreset = "custom";
    updatePerformanceConfig();
  };
  $("#request-concurrency").addEventListener("input", markCustomPerformance);
  $("#request-delay").addEventListener("input", markCustomPerformance);
  $("#index-incremental").addEventListener("change", saveIndexOptions);
  $("#request-concurrency").addEventListener("blur", normalizePerformanceInput);
  $("#request-delay").addEventListener("blur", normalizePerformanceInput);
  $("#refresh-resources").addEventListener("click", () => refreshResourceUsage().catch((error) => showToast(error.message || "资源统计失败")));
  $("#save-online-results").addEventListener("click", () => saveOnlineResults());
  $("#board-select").addEventListener("change", updateBoardSelectionStatus);
  $("#start-index").addEventListener("click", startIndex);
  $("#pause-index").addEventListener("click", pauseIndex);
  $("#clear-index").addEventListener("click", () => clearIndex().catch((error) => showToast(error.message)));
  $("#search-mode-local").addEventListener("click", () => setSearchMode("local"));
  $("#search-mode-online").addEventListener("click", () => setSearchMode("online"));
  $("#search-button").addEventListener("click", () => {
    if (state.searchMode === "online") startOnlineSearch();
    else { rememberSearch($("#query-input").value, "local"); renderResults(); }
  });
  $("#query-input").addEventListener("input", () => {
    if (state.searchMode === "local") renderResults();
    else if (!state.onlineSearchRunning) setOnlineSearchStatus("关键词已改变，点击搜索开始新的在线扫描", false);
    updateOnlineSearchControls();
  });
  $("#query-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (state.searchMode === "online") startOnlineSearch();
    else { rememberSearch($("#query-input").value, "local"); renderResults(); }
  });
  $("#sort-select").addEventListener("change", (event) => { state.sort = event.target.value; renderResults(); });
  document.querySelectorAll(".result-tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".result-tab").forEach((item) => item.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.activeType = tab.dataset.type;
    renderResults();
  }));
}

async function init() {
  bindEvents();
  loadPerformanceConfig();
  setDefaultCustomDates();
  loadSavedBoardSelection();
  loadSavedIndexOptions();
  loadIndexMetadata();
  loadSearchHistory();
  loadScopePresets();
  updateIndexRangeSummary();
  setSearchMode("online");
  await loadDocuments();
  await restoreTasks();
  try {
    await loadBoards();
  } catch (error) {
    if (state.boardListReady) {
      $("#login-state").textContent = "使用缓存版面";
      $("#login-state").classList.add("is-ready");
    } else {
      $("#login-state").textContent = "未连接";
    }
    showToast(error.message);
  }
  state.editingScopeId = state.activeScopeId;
  $("#scope-preset-name").value = state.scopePresets.find((preset) => preset.id === state.editingScopeId)?.name || "";
  renderScopePresets();
  $("#manual-board-details").open = !state.scopePresets.some((preset) => preset.id === state.activeScopeId);
}

init().catch((error) => showToast(error.message || "初始化失败"));
