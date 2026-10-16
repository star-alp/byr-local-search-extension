/*
 * 邮人全搜核心逻辑：通过论坛同源页面读取公开内容，写入扩展自己的 IndexedDB，
 * 再在浏览器本地或在线扫描范围内完成中文关键词检索。请求采用可调并发与全局限速。
 */

const DB_NAME = "byr-local-search";
const DB_VERSION = 3;
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
const RESULT_PAGE_SIZE_STORAGE_KEY = "byr-result-page-size";
const RESULT_PAGE_SIZES = [10, 20, 50, 100];
const BOARD_SELECTION_STORAGE_KEY = "byr-search-board-selection";
const INDEX_OPTIONS_STORAGE_KEY = "byr-search-index-options";
const SCOPE_PRESETS_STORAGE_KEY = "byr-search-scope-presets";
const SEARCH_HISTORY_STORAGE_KEY = "byr-search-history";
const SEARCH_SESSIONS_MAX = 20;
const INDEX_METADATA_STORAGE_KEY = "byr-search-index-metadata";
const INDEX_COVERAGE_STORAGE_KEY = "byr-search-index-coverage";
const INDEX_COVERAGE_FRESH_MS = 24 * 60 * 60 * 1000;
const RECOMMENDED_BOARD_NAMES = [
  "AimGraduate", "GraduateSch", "SICE", "StudyShare", "Talking", "Fujian",
  "SCS", "SCSS", "Paper", "JobInfo", "BBShelp"
];

const ForumModel = globalThis.ByrForumModel;
const ForumClient = globalThis.ByrForumClient;

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
  savingSearchSession: false,
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
  searchHistoryActiveIndex: -1,
  resultsPage: 1,
  resultsPageSize: 20,
  searchSessions: [],
  indexMetadata: {},
  indexCoverage: {},
  requestPolicy: ForumClient.createRequestPolicy(),
  expandedReplyGroups: new Set(),
  requestCount: 0,
  restoredOnlineTaskId: "",
  settingsBackgroundTargets: [],
  settingsGuardBound: false,
  settingsScrollState: null,
  activeModal: null,
  coverageRenderTimer: null,
  suppressPreferenceWrites: false
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
  if (state.suppressPreferenceWrites) return;
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
  if (state.suppressPreferenceWrites) return;
  localStorage.setItem(INDEX_OPTIONS_STORAGE_KEY, JSON.stringify(indexOptionValues()));
}

function loadIndexMetadata() {
  try {
    const saved = JSON.parse(localStorage.getItem(INDEX_METADATA_STORAGE_KEY) || "{}");
    state.indexMetadata = saved && typeof saved === "object" ? saved : {};
  } catch (_error) {
    state.indexMetadata = {};
  }
  try {
    state.indexCoverage = JSON.parse(localStorage.getItem(INDEX_COVERAGE_STORAGE_KEY) || "{}") || {};
  } catch (_error) {
    state.indexCoverage = {};
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

function indexedPostUnchanged(metadata, task, post) {
  return metadata
    && String(metadata.replyCount ?? "") === String(postReplyCount(post) ?? "")
    && String(metadata.postTime ?? "") === String(postUpdatedTime(post) ?? "")
    && String(metadata.title ?? "") === String(post.title ?? "")
    && metadata.timeRangeKey === indexTimeRangeKey(task.options.timeRange, task.options.timeRangeMode);
}

function shouldReadIndexedPost(task, board, post) {
  if (task.mode !== "index" || task.options.incremental === false) return true;
  const metadata = state.indexMetadata[indexedPostKey(board, post)];
  if (!indexedPostUnchanged(metadata, task, post) || !metadata.complete) return true;
  const target = Math.min(task.options.threadPageLimit ?? Infinity, metadata.totalPages || Infinity);
  return !Number.isFinite(target) || !Array.from({ length: target }, (_, index) => index + 1).every((page) => metadata.readPages?.includes(page));
}

function enqueueIndexedPost(task, board, post) {
  if (!shouldReadIndexedPost(task, board, post)) {
    task.incrementalSkipped = (task.incrementalSkipped || 0) + 1;
    return;
  }
  const metadata = state.indexMetadata[indexedPostKey(board, post)];
  // 只补缺口时复用已成功写入的页；主题发生变化后，旧页必须重新检查。
  if (task.options.missingOnly && indexedPostUnchanged(metadata, task, post) && metadata.totalPages && metadata.readPages?.length) {
    const target = Math.min(task.options.threadPageLimit ?? Infinity, metadata.totalPages);
    for (let page = 1; page <= target; page += 1) {
      ByrTasks.enqueue(task, { kind: "article", board, post, page });
      const job = task.jobs.find((item) => item.kind === "article" && item.board.name === board.name && String(item.post.gid) === String(post.gid) && item.page === page);
      if (metadata.readPages.includes(page) && job.status === "pending") {
        Object.assign(job, { status: "done", reused: true, targetPages: target, totalPages: metadata.totalPages });
      }
    }
  } else enqueuePage(task, "article", board, 1, post);
}

function rememberIndexedPages(task) {
  const topics = new Map();
  task.jobs.filter((job) => job.kind === "article").forEach((job) => {
    const key = indexedPostKey(job.board, job.post);
    if (!topics.has(key)) topics.set(key, []);
    topics.get(key).push(job);
  });
  let changed = false;
  topics.forEach((jobs, key) => {
    const successful = jobs.filter((job) => job.status === "done" && !job.skipped);
    if (!successful.length) return;
    const post = jobs[0].post;
    const readPages = successful.map((job) => job.page).sort((a, b) => a - b);
    const totalPages = Math.max(...successful.map((job) => job.totalPages || 0));
    const target = Math.min(task.options.threadPageLimit ?? Infinity, totalPages || Infinity);
    const previous = state.indexMetadata[key];
    if (indexedPostUnchanged(previous, task, post) && previous.threadPageLimit === task.options.threadPageLimit
        && previous.totalPages === totalPages && JSON.stringify(previous.readPages) === JSON.stringify(readPages)) return;
    state.indexMetadata[key] = {
      replyCount: postReplyCount(post), postTime: postUpdatedTime(post), title: post.title || "",
      threadPageLimit: task.options.threadPageLimit,
      timeRangeKey: indexTimeRangeKey(task.options.timeRange, task.options.timeRangeMode),
      readPages, totalPages,
      complete: Number.isFinite(target) && readPages.length === target && readPages.every((page, index) => page === index + 1),
      checkedAt: Date.now()
    };
    changed = true;
  });
  if (changed) {
    try { saveIndexMetadata(); } catch (error) {
      task.pauseRequested = true;
      task.error = `索引进度保存失败，请检查浏览器存储：${ForumClient.userMessage(error)}`;
    }
  }
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

function loadResultPageSize() {
  const value = Number(localStorage.getItem(RESULT_PAGE_SIZE_STORAGE_KEY));
  if (RESULT_PAGE_SIZES.includes(value)) state.resultsPageSize = value;
  const select = $("#result-page-size");
  if (select) select.value = String(state.resultsPageSize);
}

function saveResultPageSize() {
  localStorage.setItem(RESULT_PAGE_SIZE_STORAGE_KEY, String(state.resultsPageSize));
}

function updateResultPagination(total) {
  const pagination = $("#result-pagination");
  if (!pagination) return;
  const pageCount = Math.max(1, Math.ceil(total / state.resultsPageSize));
  state.resultsPage = Math.max(1, Math.min(state.resultsPage, pageCount));
  const hasPagination = total > state.resultsPageSize;
  pagination.hidden = !hasPagination;
  $("#result-page-status").textContent = `第 ${state.resultsPage} / ${pageCount} 页`;
  $("#result-prev").disabled = state.resultsPage <= 1;
  $("#result-next").disabled = state.resultsPage >= pageCount;
  $("#result-page-input").value = String(state.resultsPage);
  $("#result-page-input").max = String(pageCount);
}

function resetResultsPage() {
  state.resultsPage = 1;
}

function setResultsPage(page) {
  state.resultsPage = Math.max(1, Number(page) || 1);
  renderResults();
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
  const matches = searchHistoryMatches();
  $("#clear-search-history").hidden = !state.searchHistory.length;
  if (!matches.length) list.innerHTML = `<span class="field-help">${state.searchHistory.length ? "没有匹配的搜索记录" : "暂无搜索记录"}</span>`;
  matches.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-history-item";
    button.id = `search-history-option-${index}`;
    button.tabIndex = -1;
    button.setAttribute("role", "option");
    button.title = entry.query;
    const title = document.createElement("strong");
    title.textContent = entry.query;
    const meta = document.createElement("span");
    meta.textContent = entry.mode === "local" ? "本地" : "在线";
    button.append(title, meta);
    button.addEventListener("click", () => selectSearchHistory(entry));
    list.appendChild(button);
  });
  updateSearchHistorySelection();
}

function searchHistoryMatches() {
  const query = $("#query-input").value.trim().toLocaleLowerCase();
  return state.searchHistory.filter((entry) => entry.query.toLocaleLowerCase().includes(query));
}

function setSearchHistoryOpen(open) {
  $("#search-history").hidden = !open;
  $("#query-input").setAttribute("aria-expanded", String(open));
  if (!open) {
    state.searchHistoryActiveIndex = -1;
    updateSearchHistorySelection();
  }
}

function updateSearchHistorySelection() {
  const items = $("#search-history-list").querySelectorAll(".search-history-item");
  if (state.searchHistoryActiveIndex >= items.length) state.searchHistoryActiveIndex = -1;
  items.forEach((item, index) => {
    const active = index === state.searchHistoryActiveIndex;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  const selected = items[state.searchHistoryActiveIndex];
  if (selected) {
    $("#query-input").setAttribute("aria-activedescendant", selected.id);
    selected.scrollIntoView({ block: "nearest" });
  } else $("#query-input").removeAttribute("aria-activedescendant");
}

function selectSearchHistory(entry) {
  $("#query-input").value = entry.query;
  setSearchMode(entry.mode === "local" ? "local" : "online");
  if (Array.isArray(entry.boards) && entry.boards.length) setBoardSelection(entry.boards);
  if (entry.options) applyIndexOptionValues(entry.options);
  submitSearch();
}

function submitSearch() {
  setSearchHistoryOpen(false);
  if (state.searchMode === "online") return startOnlineSearch();
  rememberSearch($("#query-input").value, "local");
  renderResults();
}

async function loadSearchSessions() {
  try {
    state.searchSessions = (await getAll("sessions"))
      .filter((item) => item && typeof item.id === "string" && typeof item.query === "string")
      .sort((a, b) => Number(b.savedAt) - Number(a.savedAt))
      .slice(0, SEARCH_SESSIONS_MAX);
  } catch (_error) {
    state.searchSessions = [];
  }
  renderSearchSessions();
}

function renderSearchSessions() {
  const list = $("#search-session-list");
  if (!list) return;
  list.innerHTML = "";
  if (!state.searchSessions.length) {
    list.innerHTML = '<span class="field-help">暂无保存的搜索会话</span>';
    return;
  }
  state.searchSessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "search-session-item";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "search-session-restore";
    restore.title = session.query;
    const title = document.createElement("strong");
    title.textContent = session.name || session.query;
    const meta = document.createElement("span");
    meta.textContent = `${session.query} · ${Array.isArray(session.results) ? session.results.length : 0} 条 · ${formatTime(session.savedAt)}`;
    restore.append(title, meta);
    restore.addEventListener("click", () => restoreSearchSession(session.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "search-session-delete";
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteSearchSession(session.id));
    row.append(restore, remove);
    list.appendChild(row);
  });
}

function sessionId() {
  return globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function saveSearchSession() {
  if (state.savingSearchSession || state.indexRunning) return;
  const task = state.tasks.online;
  if (!task && !state.onlineDocuments.length) {
    showToast("当前没有可保存的在线搜索结果");
    return;
  }
  const query = state.onlineQuery || $("#query-input").value.trim();
  const name = window.prompt("给本次搜索会话起个名称", query || "未命名搜索");
  if (!name?.trim()) return;
  state.savingSearchSession = true;
  updateOnlineSearchControls();
  try {
    const record = {
      id: sessionId(),
      name: name.trim().slice(0, 80),
      query,
      boards: [...state.selectedBoardNames],
      options: indexOptionValues(),
      task: task ? ByrTasks.snapshot(task) : null,
      results: structuredClone(state.onlineDocuments),
      savedAt: Date.now()
    };
    await put("sessions", record);
    const sessions = (await getAll("sessions")).sort((a, b) => Number(b.savedAt) - Number(a.savedAt));
    const expired = sessions.slice(SEARCH_SESSIONS_MAX);
    if (expired.length) await withStore("sessions", "readwrite", (store) => expired.forEach((item) => store.delete(item.id)));
    await loadSearchSessions();
    showToast(`已保存搜索会话“${record.name}”`);
  } catch (error) {
    showToast(error.message || "保存搜索会话失败");
  } finally {
    state.savingSearchSession = false;
    updateOnlineSearchControls();
  }
}

async function restoreSearchSession(id) {
  if (state.onlineSearchRunning || state.indexRunning) {
    showToast("当前任务运行中，请先暂停后再恢复搜索会话");
    return;
  }
  const session = state.searchSessions.find((item) => item.id === id);
  if (!session) return;
  if ((state.onlineDocuments.length || state.tasks.online) && !window.confirm("恢复会话会替换当前在线搜索结果，继续吗？")) return;
  if (state.boards.length) setBoardSelection(session.boards || []);
  else {
    state.selectedBoardNames = new Set(session.boards || []);
    state.boardSelectionInitialized = true;
    saveBoardSelection();
  }
  if (session.options) applyIndexOptionValues(session.options);
  state.onlineQuery = session.query || "";
  $("#query-input").value = state.onlineQuery;
  state.onlineDocuments = Array.isArray(session.results) ? structuredClone(session.results) : [];
  state.onlineDocumentMap = new Map(state.onlineDocuments.map((doc) => [doc.id, doc]));
  await withStore("tasks", "readwrite", (store) => store.delete("online"));
  state.tasks.online = session.task ? structuredClone(session.task) : null;
  if (state.tasks.online) {
    state.tasks.online.pauseRequested = false;
    if (state.tasks.online.phase === "running") state.tasks.online.phase = "paused";
    state.restoredOnlineTaskId = state.tasks.online.id || "";
    updateTaskStatus(state.tasks.online);
    await put("tasks", { ...ByrTasks.snapshot(state.tasks.online), results: structuredClone(state.onlineDocuments) });
  }
  setSearchMode("online");
  renderResults();
  updateOnlineSearchControls();
  showToast("已恢复搜索会话，可继续扫描或查看当前结果");
}

async function deleteSearchSession(id) {
  const session = state.searchSessions.find((item) => item.id === id);
  if (!session || !window.confirm(`删除搜索会话“${session.name || session.query}”吗？`)) return;
  await withStore("sessions", "readwrite", (store) => store.delete(id));
  await loadSearchSessions();
  showToast("已删除搜索会话");
}

function saveScopePresets() {
  if (state.suppressPreferenceWrites) return;
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
    : state.scopePresets.length ? `已保存 ${state.scopePresets.length} 个范围` : "暂无保存范围";
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
    feedback.textContent = ForumClient.userMessage(error, "范围保存失败，请重试");
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
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
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
    const nextStart = () => {
      const limits = state.requestPolicy.limits(state.requestConcurrency, state.requestDelayMs);
      return Math.max(state.lastRequestStartedAt + limits.delayMs, limits.cooldownUntil);
    };
    let remaining = nextStart() - Date.now();
    while (remaining > 0) {
      await sleep(Math.min(remaining, 100));
      checkTaskCancelled(task);
      remaining = nextStart() - Date.now();
    }
    state.lastRequestStartedAt = Date.now();
  } finally {
    releaseGate();
  }
}

function updatePerformanceLiveStatus() {
  let label = "暂无进行中的任务";
  if (state.onlineSearchRunning) label = `在线搜索 · ${state.onlineActiveWorkers} 个活跃任务`;
  else if (state.indexRunning) label = `更新索引 · ${state.indexActiveWorkers} 个活跃任务`;
  const limits = state.requestPolicy.limits(state.requestConcurrency, state.requestDelayMs);
  if (limits.reduced) label += ` · 临时降速：同时 ${limits.concurrency} 个，每 ${limits.delayMs} 毫秒启动`;
  if (limits.cooldownUntil > Date.now()) label += " · 等待自动重试";
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
  toast.textContent = ForumClient.userMessage(message);
  toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function agentPageUrl() {
  const base = globalThis.chrome?.runtime?.getURL?.("search.html") || "chrome-extension://<扩展ID>/search.html";
  const params = new URLSearchParams({ agent: "1", api: "1", action: "configure", mode: state.searchMode, scope: "last-used", stream: "1" });
  return `${base}?${params.toString()}`;
}

function buildAgentPrompt() {
  return `你正在协助使用“邮人全搜”浏览器扩展。请优先通过程序接口或 CLI 调用扩展，不要反复截图、点击页面或读取完整网页正文。\n\n扩展 Agent 页面：\n${agentPageUrl()}\n\n推荐连接方式：本地 Agent Bridge\n1. 官方 Bridge/CLI 仓库：https://github.com/star-alp/byr-local-search-bridge。Bridge 只监听本机 127.0.0.1，不读取密码、Cookie，也不接收完整正文。\n2. 先检查当前工作目录是否已有 byr-local-search-bridge；如果没有，先克隆该公开仓库并进入目录。不要临时生成未经确认的桥接程序。\n3. 在 Bridge 仓库目录执行：node agent-cli.mjs setup --url "${agentPageUrl()}"。该命令会自动启动 Bridge、生成并保存本地令牌、打开正确的扩展页面；不要让用户手动填写端口或令牌。\n4. 执行 node agent-cli.mjs doctor，确认 Bridge、扩展和 Agent API 均已连接。若未连接，根据中文诊断继续处理，并在需要时刷新扩展页面；如果打开了错误的 Chrome 用户配置，应改为打开安装了邮人全搜的用户配置。\n5. 用户提出搜索需求后，优先执行：node agent-cli.mjs ask --query "<用户关键词>" --scope last-used --limit 20 --pretty。该命令会自动启动在线搜索、等待结果并返回结构化结果。用户没有指定范围时使用 last-used；需要版面或范围时先调用 boards 或 scopes。\n6. 返回标题、版面、作者、命中类型、摘要和原文链接；不要索要、读取或输出论坛密码、Cookie 或完整正文。清空索引、删除会话、保存结果等修改操作必须先向用户确认。\n\n只有 setup/doctor/ask 无法完成任务时，才调用 window.__BYR_LOCAL_SEARCH_AGENT_V1__ 的 getCapabilities()、startSearch()、getStatus() 和 getResults() 进行诊断。不要使用截图或反复点击页面代替 Agent API。\n\n备用连接方式：Chrome DevTools Protocol。只有用户明确允许使用专用调试 Chrome 时，才使用 9222 端口和 agent-cli.mjs；不要尝试接管用户正在运行的普通 Chrome。\n\n搜索过程中可以简洁报告进度，最终以结构化 JSON 或表格返回结果。`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许写入剪贴板");
}

async function copyAgentPrompt() {
  try {
    await copyText(buildAgentPrompt());
    showToast("Agent 提示词已复制，可粘贴给 AI");
  } catch (error) {
    showToast(error.message || "复制失败，请检查浏览器剪贴板权限");
  }
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
  renderIndexCoverage();
}

function boardTaskCoverage(task, name) {
  if (task?.mode !== "index" || !task.boards.some((board) => board.name === name)) return null;
  const jobs = task.jobs.filter((job) => job.board.name === name);
  const pages = jobs.filter((job) => job.kind === "board" && job.status === "done").length;
  return {
    options: task.options,
    complete: pages > 0 && jobs.every((job) => job.status === "done"),
    boardPages: pages,
    contentPages: jobs.filter((job) => job.kind === "article" && job.status === "done" && !job.skipped).length,
    checkedAt: task.updatedAt || Number(task.id) || 0
  };
}

function coverageStatus(record, options, hasDocuments, now = Date.now()) {
  if (!record) return { label: hasDocuments ? "部分索引" : "未建立索引", kind: "partial", hint: "尚无当前读取范围的完整扫描记录" };
  const coversPages = (saved, current) => saved === null || (current !== null && saved >= current);
  const stored = record.options;
  const sameRange = stored && indexTimeRangeKey(stored.timeRange, stored.timeRangeMode) === indexTimeRangeKey(options.timeRange, options.timeRangeMode);
  if (!record.complete || !sameRange || !coversPages(stored.boardPageLimit, options.boardPageLimit) || !coversPages(stored.threadPageLimit, options.threadPageLimit)) {
    return { label: "部分索引", kind: "partial", hint: "当前页数或日期范围尚未全部读取，可只更新缺口" };
  }
  if (now - record.checkedAt >= INDEX_COVERAGE_FRESH_MS) return { label: "可能过期", kind: "stale", hint: "距离上次完整检查已超过 24 小时，论坛内容可能有变化" };
  return { label: "已完成", kind: "complete", hint: "当前读取范围已完成，不代表版面全部历史内容" };
}

function renderIndexCoverage() {
  const byBoard = new Map();
  const ensure = (name, description = name) => {
    if (!byBoard.has(name)) byBoard.set(name, { name, description, topics: new Set(), documents: 0, replies: 0, lastCheckedAt: 0 });
    const item = byBoard.get(name);
    if (description && item.description === item.name) item.description = description;
    return item;
  };
  state.boards.forEach((board) => ensure(board.name, board.description));
  state.documents.forEach((doc) => {
    const item = ensure(doc.board, doc.boardDescription || doc.board);
    item.documents += 1;
    if (doc.type === "reply") item.replies += 1;
    if (doc.gid) item.topics.add(String(doc.gid));
    item.lastCheckedAt = Math.max(item.lastCheckedAt, Number(doc.updatedAt) || 0);
  });
  Object.entries(state.indexMetadata).forEach(([key, metadata]) => {
    const separator = key.indexOf(":");
    const boardName = separator >= 0 ? key.slice(0, separator) : key;
    const item = ensure(boardName);
    item.lastCheckedAt = Math.max(item.lastCheckedAt, Number(metadata?.checkedAt) || 0);
  });
  Object.entries(state.indexCoverage).forEach(([name, record]) => {
    ensure(name).lastCheckedAt = Math.max(ensure(name).lastCheckedAt, Number(record.checkedAt) || 0);
  });
  let options;
  try { options = readIndexOptions(); } catch (_error) { options = null; }
  const rows = [...byBoard.values()].filter((item) => item.documents || item.lastCheckedAt || state.selectedBoardNames.has(item.name))
    .sort((a, b) => Number(state.selectedBoardNames.has(b.name)) - Number(state.selectedBoardNames.has(a.name)) || b.documents - a.documents);
  rows.forEach((item) => {
    const live = boardTaskCoverage(state.tasks.index, item.name);
    const record = live && (!state.indexCoverage[item.name] || live.checkedAt >= state.indexCoverage[item.name].checkedAt) ? live : state.indexCoverage[item.name];
    item.status = options ? coverageStatus(record, options, item.documents > 0) : { label: "范围无效", kind: "partial", hint: "请检查读取页数和日期设置" };
  });
  const totalTopics = new Set(state.documents.filter((doc) => doc.gid).map((doc) => `${doc.board}:${doc.gid}`)).size;
  const latest = rows.reduce((value, item) => Math.max(value, item.lastCheckedAt), 0);
  $("#index-coverage-summary").textContent = `${state.documents.length} 条内容`;
  $("#index-coverage-summary").title = `${totalTopics} 个主题${latest ? ` · 最近 ${formatTime(latest)}` : ""}；状态按当前页数和日期范围判断`;
  const coverageToggle = $("#index-coverage-details-toggle");
  const coveragePanel = $("#index-coverage-details");
  coverageToggle.hidden = !rows.length;
  if (!rows.length) {
    coverageToggle.setAttribute("aria-expanded", "false");
    coveragePanel.hidden = true;
  }
  $("#index-coverage-list").innerHTML = rows.map((item) =>
    `<div class="index-coverage-row"><span title="${escapeHtml(item.name)}">${escapeHtml(item.description || item.name)}</span><span>${item.topics.size} 主题 · ${item.replies} 回帖</span><span class="coverage-badge is-${item.status.kind}" title="${escapeHtml(item.status.hint)}${item.lastCheckedAt ? `；最近检查 ${escapeHtml(formatTime(item.lastCheckedAt))}` : ""}">${item.status.label}</span></div>`
  ).join("");
}

function scheduleIndexCoverageRender() {
  if (state.coverageRenderTimer) return;
  state.coverageRenderTimer = window.setTimeout(() => {
    state.coverageRenderTimer = null;
    renderIndexCoverage();
  }, 500);
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

function tokenizeSearchQuery(query) {
  const tokens = [];
  let value = "";
  let quoted = false;
  let inQuotes = false;
  const push = () => {
    if (value) tokens.push({ value: value.toLocaleLowerCase(), quoted });
    value = "";
    quoted = false;
  };
  for (const character of String(query || "").trim()) {
    if (character === '"') {
      inQuotes = !inQuotes;
      quoted = true;
    } else if (/\s/u.test(character) && !inQuotes) {
      push();
    } else {
      value += character;
    }
  }
  push();
  return { tokens, valid: !inQuotes };
}

function parseSearchQuery(query) {
  const tokenized = tokenizeSearchQuery(query);
  const groups = [[]];
  const filters = { author: [], board: [], type: [] };
  const excludes = [];
  let valid = tokenized.valid;
  tokenized.tokens.forEach((token) => {
    if (token.value === "or" && !token.quoted) {
      if (!groups.at(-1).length) valid = false;
      groups.push([]);
      return;
    }
    groups.at(-1).push(token.value);
  });
  if (!groups.at(-1).length) valid = false;
  const positiveGroups = groups.map((group) => group.filter((token) => {
    let value = token;
    let negative = false;
    if (value.startsWith("-")) {
      negative = true;
      value = value.slice(1).trim();
    }
    const filter = value.match(/^(作者|author|版面|board|类型|type):(.+)$/iu);
    if (filter) {
      const field = filter[1].toLocaleLowerCase();
      const filterValue = filter[2].trim();
      if (!filterValue) { valid = false; return false; }
      if (negative) excludes.push(filterValue);
      else if (field === "作者" || field === "author") filters.author.push(filterValue);
      else if (field === "版面" || field === "board") filters.board.push(filterValue);
      else {
        const type = { 帖子: "thread", 主题: "thread", 回帖: "reply", 用户: "user", 版面: "board" }[filterValue] || filterValue;
        filters.type.push(type);
      }
      return false;
    }
    if (!value) { valid = false; return false; }
    if (negative) {
      excludes.push(value);
      return false;
    }
    return true;
  }));
  const cleanedGroups = positiveGroups.map((group) => [...new Set(group)]).filter((group) => group.length);
  const terms = [...new Set(cleanedGroups.flat())];
  const hasFilter = Object.values(filters).some((values) => values.length);
  if (!terms.length && !hasFilter) valid = false;
  return { groups: cleanedGroups, terms, filters, excludes: [...new Set(excludes)], hasPositive: terms.length > 0, valid };
}

function queryGroups(query) {
  const parsed = parseSearchQuery(query);
  return parsed.valid ? parsed.groups : [];
}

function termsFromQuery(query) {
  return parseSearchQuery(query).terms;
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

async function requestForum(path, task, textMode = false) {
  for (let attempt = 0; ; attempt += 1) {
    await waitForRequestTurn(task);
    state.requestCount += 1;
    if (task) task.requests += 1;
    $("#resource-requests").textContent = `${state.requestCount} 次`;
    try {
      const response = await chrome.runtime.sendMessage({ type: "api-via-page", sourceTabId: state.sourceTabId, path });
      if (Number.isInteger(response?.sourceTabId)) state.sourceTabId = response.sourceTabId;
      if (!response?.ok || (!textMode && !response.data?.success)) throw ForumClient.errorFromResponse(response);
      const text = String(response?.text || "");
      if (textMode && (text.includes("您未登录") || text.includes("请登录后继续操作"))) {
        throw ForumClient.errorFromResponse({ status: 401 });
      }
      state.requestPolicy.succeeded();
      updatePerformanceLiveStatus();
      return textMode ? text : response.data;
    } catch (cause) {
      const error = cause instanceof ForumClient.ForumRequestError ? cause : ForumClient.errorFromResponse({ error: cause?.message });
      if (!ForumClient.isRetryable(error)) throw error;
      state.requestPolicy.failed(error, attempt);
      updatePerformanceLiveStatus();
      if (attempt >= 2) throw error;
      if (task) task.retries = (task.retries || 0) + 1;
    }
  }
}

function requestApi(path, task) {
  return requestForum(path, task);
}

function requestForumText(path, task) {
  return requestForum(path, task, true);
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

function updateConnectionStatus(label, ready = false) {
  const boardStatus = $("#login-state");
  boardStatus.textContent = label;
  boardStatus.classList.toggle("is-ready", ready);
  const headerStatus = $("#header-login-state");
  const headerLabel = label === "加载版面" ? "检查中" : label === "使用缓存版面" ? "缓存可用" : ready ? "已连接" : "未连接";
  headerStatus.textContent = headerLabel;
  headerStatus.classList.toggle("is-ready", label === "已连接");
  headerStatus.classList.toggle("is-cached", label === "使用缓存版面");
  const forumLink = $("#forum-link");
  const connected = label === "已连接";
  forumLink.textContent = connected ? "打开论坛" : "登录论坛";
  forumLink.href = connected ? "https://bbs.byr.cn/#!default" : "https://bbs.byr.cn/n/login";
}

async function loadBoards(showMessage = false) {
  if (state.boardListLoading) return;
  const hadUsableBoards = state.boards.length > 0;
  state.boardListLoading = true;
  if (!hadUsableBoards) state.boardListReady = false;
  updateIndexButtonState();
  $("#refresh-boards").disabled = true;
  $("#refresh-boards").textContent = "正在读取版面…";
  updateConnectionStatus("加载版面");
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
    updateConnectionStatus(state.boardListReady ? "已连接" : "无可用版面", state.boardListReady);
    await refreshResourceUsage();
    if (showMessage) showToast(`已读取 ${state.boards.length} 个版面`);
  } catch (error) {
    if (hadUsableBoards) {
      state.boardListReady = true;
      if (!state.boardTree.length) state.boardTree = cachedBoardTree(state.boards);
      updateConnectionStatus("使用缓存版面", true);
    } else {
      updateConnectionStatus("未连接");
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
  scheduleIndexCoverageRender();
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
  scheduleIndexCoverageRender();
  if (state.searchMode === "local") renderResults();
}


function boardPosts(data) {
  const posts = [...(data?.posts || []), ...(data?.topPosts || []), ...(data?.article || [])]
    .map((post) => ForumModel.normalizeBoardPost(post));
  const seen = new Set();
  return posts.filter((post) => {
    const id = String(post?.gid || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function forumThreadId(post) {
  return ForumModel.threadId(post);
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
    incremental: values.incremental !== false,
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
  const documentData = ForumModel.normalizeArticle({
    board,
    boardDescription,
    post,
    result,
    article,
    toText: htmlToText
  });
  return {
    ...documentData,
    url: threadUrl(documentData)
  };
}

function documentMatchesTerms(documentData, groups, criteria = null) {
  return Boolean(matchDocument(documentData, groups, criteria));
}

function scheduleOnlineRender() {
  if (state.onlineRenderTimer) return;
  state.onlineRenderTimer = window.setTimeout(() => {
    state.onlineRenderTimer = null;
    renderResults();
  }, 160);
}

function addOnlineDocument(documentData, groups, criteria = null) {
  if (!documentMatchesTerms(documentData, groups, criteria)) return;
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

function mergeOnlineDocuments(documents, groups, criteria = null) {
  documents.forEach((doc) => {
    const previous = state.onlineDocumentMap.get(doc.id);
    if (doc.cachePreview && previous?.contentFetched && !previous.cachePreview) return;
    if (previous?.fetchedAt > doc.fetchedAt) return;
    // 最新正文不再匹配时，移除此前显示的缓存命中或快速候选。
    if (!documentMatchesTerms(doc, groups, criteria)) {
      if (state.onlineDocumentMap.delete(doc.id)) state.onlineDocuments = state.onlineDocuments.filter((item) => item.id !== doc.id);
    } else addOnlineDocument(doc, groups, criteria);
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
  const criteria = parseSearchQuery(task.query);
  const groups = criteria.groups;
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
          .map((doc) => ({ ...doc, cachedAt: cached.fetchedAt, fetchedAt: cached.fetchedAt, cachePreview: true })), groups, criteria);
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

function setSearchStatusPanel(panelId, open) {
  document.querySelectorAll("[data-status-panel]").forEach((button) => {
    const id = button.dataset.statusPanel;
    if (id !== panelId && !open) return;
    const expanded = id === panelId && open;
    button.setAttribute("aria-expanded", String(expanded));
    $("#" + id).hidden = !expanded;
  });
}

function setModalOpen(dialog, open) {
  const layout = $("#app-layout");
  const setBackgroundBlocked = (blocked) => {
    if (blocked) {
      if (state.activeModal && state.activeModal !== dialog) setModalOpen(state.activeModal, false);
      if (!state.settingsBackgroundTargets.length) {
        const targets = [document.querySelector(".app-header"), ...(dialog.closest("#app-layout")
          ? [...layout.children].filter((item) => item !== dialog)
          : [layout])].filter(Boolean);
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
          if (!state.activeModal?.open || state.activeModal.contains(event.target)) return;
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
      state.activeModal = dialog;
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
    if (state.activeModal === dialog) state.activeModal = null;
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

function setSettingsOpen(open) {
  setModalOpen($("#search-settings"), open);
}

function setAgentHelpOpen(open) {
  const dialog = $("#agent-help-dialog");
  if (open) {
    $("#agent-help-command").textContent = `node agent-cli.mjs setup --url "${agentPageUrl()}"`;
    const status = $("#agent-bridge-status");
    const helpStatus = $("#agent-help-connection");
    helpStatus.textContent = status?.textContent || "Agent 未连接";
    helpStatus.classList.toggle("is-connected", Boolean(status?.classList.contains("is-connected")));
  }
  setModalOpen(dialog, open);
}

function updateOnlineSearchControls() {
  const task = state.tasks.online;
  const online = state.searchMode === "online";
  const running = state.onlineSearchRunning;
  const paused = task?.phase === "paused";
  const failures = task?.jobs.filter((job) => job.status === "failed") || [];
  $("#online-search-details-toggle").hidden = !online;
  $("#search-progress-header").hidden = !online && $("#task-skipped-summary").hidden;
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
  const canSaveSession = online && Boolean(task || state.onlineDocuments.length);
  $("#save-search-session").hidden = !canSaveSession;
  $("#save-search-session").disabled = state.savingSearchSession || state.indexRunning || !canSaveSession;
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
  $("#fill-index-gaps").disabled = state.indexRunning || state.onlineSearchRunning || state.boardListLoading || !state.selectedBoardNames.size;
  $("#pause-index").disabled = !state.indexRunning || Boolean(state.tasks.index?.pauseRequested);
  $("#pause-index").textContent = state.tasks.index?.pauseRequested && state.indexRunning ? "暂停中" : "暂停";
  updateIndexButtonState();
  renderScopePresets();
}

function updateTaskStatus(task, active = 0) {
  if (task.mode === "index") rememberIndexedPages(task);
  const metrics = ByrTasks.metrics(task);
  const labels = { running: task.pauseRequested ? "正在暂停" : "正在读取与搜索", paused: "已暂停，可继续", partial: "部分完成", complete: "所选范围扫描完成" };
  const phaseLabel = task.mode === "online" && state.restoredOnlineTaskId === task.id && !state.onlineSearchRunning
    ? "已恢复上次搜索"
    : labels[task.phase];
  const text = `${phaseLabel} · 版面 ${metrics.boards}/${metrics.boardTotal} · 已读取 ${metrics.boardPages} 个主题页、${metrics.contentPages} 个内容页 · 涉及 ${metrics.threads} 个主题 · 请求 ${task.requests} 次`
    + (task.mode === "online" ? ` · 原生搜索 ${metrics.nativePages} 页` : "")
    + (task.mode === "online" ? ` · 命中 ${state.onlineDocuments.length} 条` : "")
    + (task.mode === "index" && task.incrementalSkipped ? ` · 跳过 ${task.incrementalSkipped} 个未变化主题` : "")
    + (metrics.reusedPages ? ` · 复用 ${metrics.reusedPages} 个已索引页` : "")
    + (task.retries ? ` · 自动重试 ${task.retries} 次` : "")
    + (metrics.skipped ? ` · 跳过 ${metrics.skipped} 个失效主题` : "")
    + (task.cachePages ? ` · 复用 ${task.cachePages} 个内容页（${formatTime(task.cacheOldestAt)} 获取）` : "")
    + (metrics.failures.length ? ` · 失败 ${metrics.failures.length} 项` : "")
    + (task.error ? ` · ${ForumClient.userMessage(task.error)}` : "");
  const compact = task.mode === "online"
    ? `${phaseLabel} · 已找到 ${state.onlineDocuments.length} 条`
    : `${task.phase === "complete" ? "扫描完成" : labels[task.phase]} · 已读 ${metrics.boardPages + metrics.contentPages} 页 · 版面 ${metrics.boards}/${metrics.boardTotal}`;
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
    `<p>${job.mode === "online" ? "在线搜索" : "本地更新"} · ${escapeHtml(job.board.description)} · ${job.kind === "native" ? "论坛快速搜索" : job.kind === "board" ? "主题列表" : `主题 ${escapeHtml(job.post.gid)}`} 第 ${job.page || 1} 页：${escapeHtml(ForumClient.userMessage(job.error, "论坛请求失败，请重试"))}</p>`
  ).join("");
  const skippedJobs = Object.values(state.tasks).filter(Boolean).flatMap((item) =>
    item.jobs.filter((job) => job.status === "done" && job.skipped && !job.ignored).map((job) => ({ ...job, mode: item.mode }))
  );
  $("#task-skipped-summary").hidden = !skippedJobs.length;
  if (!skippedJobs.length) setSearchStatusPanel("task-skipped", false);
  $("#task-skipped-summary").textContent = `已跳过主题（${skippedJobs.length}）`;
  $("#task-skipped-list").innerHTML = skippedJobs.map((job) => {
    const href = threadUrl({ type: "thread", board: job.board.name, gid: job.post.gid });
    return `<p><span>${escapeHtml(job.board.description)} · 主题 ${escapeHtml(job.post.gid)}：${escapeHtml(ForumClient.userMessage(job.skipReason, "主题不存在或主题数据无效"))}</span><a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">打开</a><button type="button" data-retry-skipped="${escapeHtml(`${job.mode}:${job.id}`)}">重新检查</button></p>`;
  }).join("");
  updateOnlineSearchControls();
  updatePerformanceLiveStatus();
  scheduleIndexCoverageRender();
}

function nativeSearchDays(timeRange) {
  if (!timeRange) return 0;
  return Math.max(1, Math.ceil((Date.now() - timeRange.start) / 86400000));
}

function nativeSearchValue(value) {
  return encodeURIComponent(encodeURIComponent(String(value || "")));
}

function nativeSearchPaths(boardName, query, options) {
  const criteria = parseSearchQuery(query);
  const groups = criteria.groups;
  const common = `b=${nativeSearchValue(boardName)}&d=${nativeSearchDays(options.timeRange)}`;
  const paths = groups.flatMap((terms) => {
    const titleTerms = [`t1=${nativeSearchValue(terms[0])}`];
    if (terms[1]) titleTerms.push(`t2=${nativeSearchValue(terms[1])}`);
    return [`/s/article?${common}&${titleTerms.join("&")}`];
  });
  criteria.filters.author.forEach((author) => paths.push(`/s/article?${common}&au=${nativeSearchValue(author)}`));
  criteria.groups.filter((terms) => terms.length === 1 && /^[a-z][a-z0-9_]{1,19}$/u.test(terms[0]))
    .forEach((terms) => paths.push(`/s/article?${common}&au=${nativeSearchValue(terms[0])}`));
  return [...new Set(paths)];
}

function nativeResultTime(value) {
  const text = String(value || "").replace(/\s+/gu, " ").trim();
  if (/^\d{2}:\d{2}:\d{2}$/u.test(text)) return `${dateInputValue(new Date())} ${text}`;
  return text;
}

function parseNativeSearchPage(html, fallbackBoard, groups, path, pageLimit, criteria = null) {
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
    if (matchDocument(documentData, groups, criteria || { groups, hasPositive: groups.length, excludes: [], filters: { author: [], board: [], type: [] } })) results.push(documentData);
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
      if (!state.checkpointError) showToast("进度保存失败；请保持页面打开：" + ForumClient.userMessage(error));
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
  if (cached) {
    const criteria = parseSearchQuery(task.query);
    mergeOnlineDocuments(readArticleDocuments(board, post, cached.result, task.options.timeRange)
      .map((doc) => ({ ...doc, cachedAt: cached.fetchedAt, fetchedAt: cached.fetchedAt, cachePreview: true })), criteria.groups, criteria);
  }
}

async function executeTaskJob(task, job) {
  checkTaskCancelled(task);
  const criteria = parseSearchQuery(task.query);
  const groups = criteria.groups;
  const { board, post, page } = job;
  if (job.kind === "native") {
    const html = await requestForumText(job.path, task);
    const nativePage = parseNativeSearchPage(html, board, groups, job.path, task.options.boardPageLimit, parseSearchQuery(task.query));
    if (nativePage.nextPath) ByrTasks.enqueue(task, { kind: "native", board, path: nativePage.nextPath, page: page + 1 });
    const results = nativePage.documents
      .filter((doc) => inIndexTimeRange(doc.time, task.options.timeRange));
    results.forEach((doc) => {
      addOnlineDocument(doc, groups, criteria);
      // 原生搜索找到的历史主题也读取正文，补全快速候选。
      enqueuePage(task, "article", board, 1, { gid: doc.gid, title: doc.title, poster: doc.author, time: doc.time });
    });
    return;
  }
  const path = job.kind === "board"
    ? `/n/b/board/${encodeURIComponent(board.name)}.json?page=${page}`
    : `/n/b/article/${encodeURIComponent(board.name)}/${encodeURIComponent(post.gid)}.json?page=${page}`;
  const cached = job.kind === "article" && task.mode === "online" ? getSessionPage(path, task) : null;
  let result;
  try {
    result = cached?.result || await requestApi(path, task);
  } catch (error) {
    if (job.kind === "article" && ForumClient.isThreadUnavailable(error)) {
      job.skipped = true;
      job.skipReason = error.message || "主题不存在或主题数据无效";
      return;
    }
    throw error;
  }
  if (cached) {
    task.cachePages = (task.cachePages || 0) + 1;
    task.cacheOldestAt = Math.min(task.cacheOldestAt || cached.fetchedAt, cached.fetchedAt);
  } else rememberSessionPage(path, result);
  const total = Math.max(1, Number(result.data?.pagination?.total) || 1);
  const limit = job.kind === "board" ? task.options.boardPageLimit : task.options.threadPageLimit;
  const pageLimit = limit === null ? total : Math.min(total, limit);
  job.targetPages = pageLimit;
  job.totalPages = total;
  if (page < pageLimit) enqueuePage(task, job.kind, board, page + 1, post);
  if (job.kind === "board") {
    boardPosts(result.data).forEach((item) => {
      if (task.mode === "index") enqueueIndexedPost(task, board, item);
      else enqueuePage(task, "article", board, 1, item);
    });
    return;
  }
  const fetchedAt = cached?.fetchedAt || Date.now();
  const documents = readArticleDocuments(board, post, result, task.options.timeRange)
    .map((doc) => ({ ...doc, cachedAt: cached?.fetchedAt || null, fetchedAt, cachePreview: false }));
  if (task.mode === "online") {
    mergeOnlineDocuments(documents, groups, criteria);
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
    await ByrTasks.run(task, (job) => executeTaskJob(task, job), () => state.requestPolicy.limits(state.requestConcurrency, state.requestDelayMs).concurrency,
      (active) => { task.updatedAt = Date.now(); updateTaskStatus(task, active); queueCheckpoint(); }, state.queueSchedulers);
    if (task.mode === "online" && task.phase === "complete") {
      // 预览的旧目录可能已变化；完成后只保留本次实际扫描确认过的内容。
      state.onlineDocuments = state.onlineDocuments.filter((doc) => !doc.cachePreview);
      state.onlineDocumentMap = new Map(state.onlineDocuments.map((doc) => [doc.id, doc]));
    }
    await persistTasks();
    state.checkpointError = "";
  } catch (error) {
    task.phase = "paused";
    task.error = "任务暂停：" + ForumClient.userMessage(error, "无法保存进度");
  } finally {
    state.onlineSearchRunning = false;
    state.indexRunning = false;
    state.onlineActiveWorkers = 0;
    state.indexActiveWorkers = 0;
    if (task.mode === "index") {
      task.boards.forEach((board) => { state.indexCoverage[board.name] = boardTaskCoverage(task, board.name); });
      try { localStorage.setItem(INDEX_COVERAGE_STORAGE_KEY, JSON.stringify(state.indexCoverage)); }
      catch (error) { showToast(`索引内容已保留，覆盖状态保存失败：${ForumClient.userMessage(error)}`); }
    }
    updateTaskStatus(task);
    renderResults();
    await refreshResourceUsage();
  }
}

async function startNewTask(mode, fresh = false, overrides = {}, control = {}) {
  if (state.indexRunning || state.onlineSearchRunning) return;
  const query = mode === "online" ? $("#query-input").value.trim() : "";
  if (mode === "online" && !query) { showToast("请输入搜索关键词"); return; }
  if (mode === "online" && !parseSearchQuery(query).valid) { showToast("请检查关键词、OR 或筛选条件"); return; }
  if (mode === "online") {
    if (control.remember !== false) rememberSearch(query, mode);
    resetResultsPage();
  }
  const previous = state.tasks[mode];
  if (previous?.phase === "paused" && !control.confirm && !window.confirm("开始新任务会替换当前暂停任务的进度，已保存的本地内容会保留。继续吗？")) return;
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
      state.expandedReplyGroups.clear();
      state.onlineDocuments = [];
      state.onlineDocumentMap.clear();
      state.onlineQuery = query;
      primeSessionResults(task);
    }
    const running = runTask(task);
    if (control.background) {
      running.catch((error) => { task.error = ForumClient.userMessage(error); task.phase = "paused"; });
      return task;
    }
    await running;
  } catch (error) {
    if (control.background) throw error;
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

async function retrySkippedJob(mode, jobId) {
  if (state.indexRunning || state.onlineSearchRunning) return;
  const task = state.tasks[mode];
  const job = task?.jobs.find((item) => item.id === jobId && item.skipped);
  if (!task || !job) return;
  delete job.skipped;
  delete job.skipReason;
  job.status = "pending";
  task.phase = "paused";
  await runTask(task);
}

function startIndex() {
  return state.tasks.index?.phase === "paused" ? continueTask("index") : startNewTask("index");
}

function startFullIndex() {
  return startNewTask("index", false, { incremental: false });
}

function startMissingIndex() {
  return startNewTask("index", false, { incremental: true, missingOnly: true });
}

function pauseIndex() {
  pauseTask("index");
}

function setSearchMode(mode) {
  const online = mode === "online";
  if (state.onlineSearchRunning && !online) { showToast("请先暂停搜索"); return; }
  state.searchMode = online ? "online" : "local";
  resetResultsPage();
  $("#search-mode-local").classList.toggle("is-active", !online);
  $("#search-mode-online").classList.toggle("is-active", online);
  $("#search-mode-local").setAttribute("aria-selected", String(!online));
  $("#search-mode-online").setAttribute("aria-selected", String(online));
  $("#online-search-status").hidden = !online;
  if (!online) setSearchStatusPanel("online-search-status-details", false);
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

function matchDocument(documentData, groups, criteria = null) {
  const queryCriteria = criteria || { groups, excludes: [], filters: { author: [], board: [], type: [] }, hasPositive: groups.length > 0 };
  if (!groups.length && !Object.values(queryCriteria.filters || {}).some((values) => values.length)) return null;
  // 回帖只匹配自身正文和作者，主题标题、版面信息只是上下文。
  const keys = documentData.type === "reply" ? ["content", "author", "authorName"]
    : ["title", "content", "author", "authorName", "board", "boardDescription"];
  const fields = keys.map((key) => [key, String(documentData[key] || "").toLocaleLowerCase()]);
  const text = fields.map(([, value]) => value).join(" ");
  if ((queryCriteria.excludes || []).some((term) => text.includes(term))) return null;
  const filters = queryCriteria.filters || { author: [], board: [], type: [] };
  const authorText = `${documentData.author || ""} ${documentData.authorName || ""}`.toLocaleLowerCase();
  const boardText = `${documentData.board || ""} ${documentData.boardDescription || ""}`.toLocaleLowerCase();
  if (filters.author.length && !filters.author.some((term) => authorText.includes(term))) return null;
  if (filters.board.length && !filters.board.some((term) => boardText.includes(term))) return null;
  if (filters.type.length && !filters.type.includes(documentData.type)) return null;
  const terms = matchingTerms(text, groups);
  if (queryCriteria.hasPositive && !terms.length) return null;
  const weights = { title: 8, content: 4, author: 7, authorName: 7, board: 2, boardDescription: 2 };
  let score = filters.author.length + filters.board.length + filters.type.length;
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
      key: group.key,
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

function searchDocuments(query, type = state.activeType) {
  const criteria = parseSearchQuery(query);
  if (!criteria.valid) return [];
  const groups = criteria.groups;
  const source = searchSourceDocuments();
  const candidates = source.filter((documentData) => (type === "all" || documentData.type === type)
    && (!criteria.filters.type.length || criteria.filters.type.includes(documentData.type)));
  return candidates.map((documentData) => {
    const match = matchDocument(documentData, groups, criteria);
    return match ? { documentData, ...match } : null;
  }).filter(Boolean).sort(compareResults);
}

function boardResults(query) {
  const criteria = parseSearchQuery(query);
  const groups = criteria.groups;
  const terms = criteria.terms;
  if (!criteria.valid) return [];
  return state.boards.filter((board) => {
    if (state.searchMode === "local" && !state.selectedBoardNames.has(board.name)) return false;
    const fields = `${board.name} ${board.description}`.toLocaleLowerCase();
    if (criteria.excludes.some((term) => fields.includes(term))) return false;
    if (criteria.filters.board.length && !criteria.filters.board.some((term) => fields.includes(term))) return false;
    if (criteria.filters.type.length && !criteria.filters.type.includes("board")) return false;
    return !criteria.hasPositive || matchingTerms(fields, groups).length > 0;
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
  const criteria = parseSearchQuery(query);
  const groups = criteria.groups;
  const terms = criteria.terms;
  if (!criteria.valid) return [];
  const users = new Map();
  const source = searchSourceDocuments();
  source.forEach((documentData) => {
    const id = documentData.author || "";
    const name = documentData.authorName || "";
    const fields = `${id} ${name}`.toLocaleLowerCase();
    if (!id || (criteria.hasPositive && !matchingTerms(fields, groups).length)) return;
    if (criteria.excludes.some((term) => fields.includes(term))) return;
    if (criteria.filters.author.length && !criteria.filters.author.some((term) => fields.includes(term))) return;
    if (criteria.filters.board.length && !criteria.filters.board.some((term) => String(documentData.board || "").toLocaleLowerCase().includes(term))) return;
    if (criteria.filters.type.length && !criteria.filters.type.includes(documentData.type)) return;
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
    <div class="result-child-meta"><span class="result-kind">第 ${escapeHtml(documentData.pos || 0)} 楼</span><span>${highlight(documentData.author || "已注销", terms)}</span><span>${escapeHtml(formatTime(documentData.time))}</span><span class="result-link-hint">跳到此楼 ↗</span></div>
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
    + (extra.length ? `<details class="result-child-more" data-reply-group="${escapeHtml(group.key)}"${state.expandedReplyGroups.has(group.key) ? " open" : ""}><summary>还有 ${extra.length} 条回帖命中</summary>${extra.map(renderMatchedReply).join("")}</details>` : "");
  return `<article class="result-card result-group">
    <a class="result-group-main" href="${escapeHtml(threadUrl(documentData, parent.terms || []))}" target="_blank" rel="noreferrer">
    <h3 class="result-title">${highlight(documentData.title || "无标题", parent.terms || [])}</h3>
    <div class="result-meta"><span class="result-kind">帖子</span><span>${escapeHtml(documentData.boardDescription || documentData.board)}</span>${documentData.author ? `<span>${escapeHtml(documentData.author)}</span>` : ""}<span>${escapeHtml(formatTime(documentData.time))}</span><span>${escapeHtml(matchSummary)}${replies.length ? `（${replies.length} 条）` : ""}</span>${documentData.nativeSearch ? '<span class="result-source">论坛快速匹配</span>' : ""}<span class="result-link-hint">打开原文 ↗</span></div>
    ${state.searchMode === "online" && documentData.cachedAt ? `<p class="field-help">${documentData.cachePreview ? "缓存预览" : "缓存内容"} · ${escapeHtml(formatTime(documentData.cachedAt))} 获取</p>` : ""}
    ${documentData.content ? `<p class="result-snippet">${highlight(getSnippet(documentData.content, parent.terms || []), parent.terms || [])}</p>` : ""}
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
    updateResultPagination(0);
    const sourceCount = searchSourceDocuments().length;
    $("#result-count").textContent = sourceCount ? `当前有 ${sourceCount} 条内容` : "输入关键词开始搜索";
    list.innerHTML = `<div class="empty-state"><strong>输入关键词开始搜索</strong><p>${state.searchMode === "online" ? "点击搜索后会扫描当前选择的版面范围。" : "结果会在当前浏览器本地完成匹配。"}</p></div>`;
    return;
  }
  if (!parseSearchQuery(query).valid) {
    updateResultPagination(0);
    $("#result-count").textContent = "请检查关键词";
    list.innerHTML = '<div class="empty-state"><strong>搜索条件格式有误</strong><p>请检查引号、OR 或筛选条件。</p></div>';
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
    updateResultPagination(0);
    const message = state.searchMode === "online" && state.onlineSearchRunning
      ? "正在扫描，匹配结果会陆续显示。"
      : "可以换一个关键词，或扩大版面和历史范围。";
    list.innerHTML = `<div class="empty-state"><strong>没有找到匹配内容</strong><p>${message}</p></div>`;
    return;
  }
  const displayResults = results.slice(0, 200);
  updateResultPagination(displayResults.length);
  const pageStart = (state.resultsPage - 1) * state.resultsPageSize;
  list.innerHTML = displayResults.slice(pageStart, pageStart + state.resultsPageSize).map((result) => {
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
  state.indexMetadata = {};
  state.indexCoverage = {};
  state.tasks.index = null;
  await withStore("tasks", "readwrite", (store) => store.delete("index"));
  saveIndexMetadata();
  localStorage.setItem(INDEX_COVERAGE_STORAGE_KEY, "{}");
  setIndexStatus("本地索引已清空", 0);
  renderResults();
  await refreshResourceUsage();
  updateOnlineSearchControls();
  showToast("本地索引已清空");
}

function bindEvents() {
  const queryInput = $("#query-input");
  const historyWrap = $(".query-input-wrap");
  const showSearchHistory = () => { renderSearchHistory(); setSearchHistoryOpen(true); };
  queryInput.addEventListener("focus", showSearchHistory);
  queryInput.addEventListener("click", showSearchHistory);
  document.addEventListener("pointerdown", (event) => {
    if (!historyWrap.contains(event.target)) setSearchHistoryOpen(false);
  });
  historyWrap.addEventListener("focusout", (event) => {
    if (!historyWrap.contains(event.relatedTarget)) setSearchHistoryOpen(false);
  });
  $("#clear-search-history").addEventListener("click", () => {
    state.searchHistory = [];
    state.searchHistoryActiveIndex = -1;
    saveSearchHistory();
    queryInput.focus();
    renderSearchHistory();
  });
  document.querySelectorAll("[data-status-panel]").forEach((button) => button.addEventListener("click", () => {
    setSearchStatusPanel(button.dataset.statusPanel, button.getAttribute("aria-expanded") !== "true");
  }));
  $("#search-sessions-toggle").addEventListener("click", () => {
    const panel = $("#search-sessions");
    panel.hidden = !panel.hidden;
    $("#search-sessions-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#result-list").addEventListener("toggle", (event) => {
    const details = event.target;
    if (!details.isConnected || !details.matches("details[data-reply-group]")) return;
    if (details.open) state.expandedReplyGroups.add(details.dataset.replyGroup);
    else state.expandedReplyGroups.delete(details.dataset.replyGroup);
  }, true);
  $("#fresh-online").addEventListener("click", () => startNewTask("online", true));
  $("#open-settings").addEventListener("click", () => setSettingsOpen(true));
  $("#open-agent-help").addEventListener("click", () => setAgentHelpOpen(true));
  $("#copy-agent-prompt").addEventListener("click", copyAgentPrompt);
  $("#close-settings").addEventListener("click", () => setSettingsOpen(false));
  $("#search-settings").addEventListener("cancel", (event) => { event.preventDefault(); setSettingsOpen(false); });
  $("#close-agent-help").addEventListener("click", () => setAgentHelpOpen(false));
  $("#agent-help-close-secondary").addEventListener("click", () => setAgentHelpOpen(false));
  $("#agent-help-dialog").addEventListener("cancel", (event) => { event.preventDefault(); setAgentHelpOpen(false); });
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
  $("#fill-index-gaps").addEventListener("click", startMissingIndex);
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
  $("#save-search-session").addEventListener("click", () => saveSearchSession());
  $("#board-select").addEventListener("change", updateBoardSelectionStatus);
  $("#start-index").addEventListener("click", startIndex);
  $("#pause-index").addEventListener("click", pauseIndex);
  $("#clear-index").addEventListener("click", () => clearIndex().catch((error) => showToast(error.message)));
  $("#search-mode-local").addEventListener("click", () => setSearchMode("local"));
  $("#search-mode-online").addEventListener("click", () => setSearchMode("online"));
  $("#search-button").addEventListener("click", submitSearch);
  $("#query-input").addEventListener("input", () => {
    state.searchHistoryActiveIndex = -1;
    showSearchHistory();
    resetResultsPage();
    if (state.searchMode === "local") renderResults();
    else if (!state.onlineSearchRunning) setOnlineSearchStatus("关键词已改变，点击搜索开始新的在线扫描", false);
    updateOnlineSearchControls();
  });
  $("#query-input").addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape" && !$("#search-history").hidden) {
      event.preventDefault();
      setSearchHistoryOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if ($("#search-history").hidden) showSearchHistory();
      const count = searchHistoryMatches().length;
      if (!count) return;
      const current = state.searchHistoryActiveIndex;
      state.searchHistoryActiveIndex = current < 0
        ? event.key === "ArrowDown" ? 0 : count - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      updateSearchHistorySelection();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const entry = !$("#search-history").hidden && searchHistoryMatches()[state.searchHistoryActiveIndex];
    if (entry) selectSearchHistory(entry);
    else submitSearch();
  });
  $("#sort-select").addEventListener("change", (event) => { state.sort = event.target.value; resetResultsPage(); renderResults(); });
  $("#result-page-size").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (!RESULT_PAGE_SIZES.includes(value)) return;
    state.resultsPageSize = value;
    saveResultPageSize();
    resetResultsPage();
    renderResults();
  });
  $("#result-prev").addEventListener("click", () => setResultsPage(state.resultsPage - 1));
  $("#result-next").addEventListener("click", () => setResultsPage(state.resultsPage + 1));
  $("#result-page-input").addEventListener("change", (event) => setResultsPage(event.target.value));
  $("#result-page-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setResultsPage(event.target.value);
  });
  $("#task-skipped-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-retry-skipped]");
    if (!button) return;
    const [mode, ...parts] = String(button.dataset.retrySkipped || "").split(":");
    retrySkippedJob(mode, parts.join(":")).catch((error) => showToast(error.message || "重新检查失败"));
  });
  document.querySelectorAll(".result-tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".result-tab").forEach((item) => item.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.activeType = tab.dataset.type;
    resetResultsPage();
    renderResults();
  }));
}

function agentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function prepareAgentSearch(options, search) {
  if (state.onlineSearchRunning || state.indexRunning || state.boardListLoading) throw agentError("BUSY", "当前任务正在运行，请等待完成或先停止搜索");
  if ($("#search-settings").open) throw agentError("SETTINGS_OPEN", "请先关闭更多设置窗口");
  const mode = options.mode || state.searchMode;
  if (options.query !== undefined && !parseSearchQuery(options.query).valid) throw agentError("INVALID_QUERY", "请检查关键词、OR 或筛选条件");
  if (search && mode === "online" && state.tasks.online?.phase === "paused" && !options.confirm) throw agentError("CONFIRMATION_REQUIRED", "存在暂停的在线任务；替换进度前请设置 confirm: true");
  const scopeId = options.scope === "recommended" ? "recommended" : options.scope?.startsWith("saved:") ? options.scope.slice(6) : "current";
  const preset = scopeId === "current" ? null : scopePreset(scopeId);
  if (scopeId !== "current" && !preset) throw agentError("SCOPE_NOT_FOUND", "找不到该常用范围，请调用 listScopes 查看有效 ID");
  const requested = options.boards || preset?.boards || [...state.selectedBoardNames];
  const boards = resolveBoardNames(requested);
  const unknown = requested.filter((name) => !resolveBoardNames([name]).length);
  if (unknown.length) throw agentError("BOARD_NOT_FOUND", `版面不存在或尚未加载：${unknown.join("、")}`);
  if (search && !boards.length) throw agentError("NO_BOARDS", "请先登录论坛并读取版面，然后选择至少一个版面");
  const values = { ...indexOptionValues(), ...preset?.options };
  for (const [field, all] of [["boardPages", "boardAll"], ["threadPages", "threadAll"]]) if (options[field] !== undefined) {
    values[all] = options[field] === null;
    if (options[field] !== null) values[field] = options[field];
  }
  for (const field of ["timeRange", "dateFrom", "dateTo"]) if (options[field] !== undefined) values[field] = options[field];
  try { readIndexOptions(values); }
  catch (error) { throw agentError("INVALID_ARGUMENT", error.message); }
  return { mode, query: options.query, scopeId, boards, values };
}

function configureAgentSearch(prepared, options) {
  const previous = state.suppressPreferenceWrites;
  state.suppressPreferenceWrites = !options.persist;
  try {
    state.activeScopeId = prepared.scopeId;
    applyIndexOptionValues(prepared.values);
    setBoardSelection(prepared.boards);
    if (prepared.query !== undefined) $("#query-input").value = prepared.query;
    setSearchHistoryOpen(false);
    setSearchMode(prepared.mode);
    if (options.persist) saveScopePresets();
  } finally { state.suppressPreferenceWrites = previous; }
}

function agentSearchView() {
  const online = state.searchMode === "online";
  const task = online ? state.tasks.online : null;
  const query = online && state.onlineQuery ? state.onlineQuery : $("#query-input").value;
  const boards = task?.boards.map((board) => board.name) || [...state.selectedBoardNames];
  const options = task?.options || indexOptionValues();
  const running = online && state.onlineSearchRunning;
  const metrics = task ? ByrTasks.metrics(task) : null;
  return {
    source: task,
    key: JSON.stringify([state.searchMode, query, boards, options]),
    status: {
      mode: state.searchMode, query, boards, options, running,
      status: running ? task?.pauseRequested ? "stopping" : "running" : task?.phase || (query.trim() ? online ? "idle" : "complete" : "idle"),
      connection: $("#login-state").textContent,
      progress: {
        scannedBoards: metrics?.boards || 0, totalBoards: metrics?.boardTotal ?? boards.length,
        boardPages: metrics?.boardPages || 0, contentPages: metrics?.contentPages || 0, nativePages: metrics?.nativePages || 0,
        threads: metrics?.threads || 0, requestCount: task?.requests || 0, failures: metrics?.failures.length || 0, skipped: metrics?.skipped || 0
      },
      error: task?.error ? { code: "TASK_PAUSED", message: ForumClient.userMessage(task.error) } : null
    }
  };
}

const agentController = ByrAgent.create({
  userMessage: (error) => ForumClient.userMessage(error, "Agent 调用失败，请重试"),
  prepare: prepareAgentSearch,
  configure: configureAgentSearch,
  async start(prepared, options) {
    configureAgentSearch(prepared, options);
    if (prepared.mode === "online") {
      await startNewTask("online", false, {}, { background: true, remember: options.persist, confirm: options.confirm });
    } else {
      if (options.persist) rememberSearch(prepared.query, "local");
      renderResults();
    }
  },
  view: agentSearchView,
  results() {
    const query = agentSearchView().status.query;
    // 程序接口返回独立的正文与回帖命中，不受页面分页、折叠和分类导航影响。
    return searchDocuments(query, "all").map(({ documentData: doc, score, matchedFields, terms }) => ({
      id: doc.id, type: doc.type, title: doc.title || "", board: doc.board, boardDescription: doc.boardDescription || "",
      author: doc.author || "", authorName: doc.authorName || "", threadId: String(doc.threadId || doc.gid || ""),
      articleId: doc.articleId ? String(doc.articleId) : null, position: doc.pos ?? 0, time: doc.time ?? null,
      snippet: getSnippet(doc.content, terms), score, matchedFields, terms,
      url: threadUrl(doc, terms), provisional: Boolean(doc.cachePreview), fetchedAt: doc.fetchedAt || null
    }));
  },
  scopes: () => [
    { id: "last-used", name: "当前选择", boards: [...state.selectedBoardNames], options: indexOptionValues() },
    ...[scopePreset("recommended"), ...state.scopePresets].map((preset) => ({ ...preset, id: preset.id === "recommended" ? preset.id : `saved:${preset.id}` }))
  ],
  boards: (query) => state.boards.filter((board) => `${board.name} ${board.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((board) => ({ id: board.name, name: board.description, selected: state.selectedBoardNames.has(board.name) })),
  cancel: () => pauseTask("online")
});
Object.defineProperty(globalThis, ByrAgent.GLOBAL_NAME, { value: agentController.api });

async function init() {
  bindEvents();
  loadPerformanceConfig();
  setDefaultCustomDates();
  loadSavedBoardSelection();
  loadSavedIndexOptions();
  loadIndexMetadata();
  loadSearchHistory();
  loadResultPageSize();
  await loadSearchSessions();
  loadScopePresets();
  updateIndexRangeSummary();
  setSearchMode("online");
  await loadDocuments();
  await restoreTasks();
  try {
    await loadBoards();
  } catch (error) {
    if (state.boardListReady) {
      updateConnectionStatus("使用缓存版面", true);
    } else {
      updateConnectionStatus("未连接");
    }
    showToast(error.message);
  }
  state.editingScopeId = state.activeScopeId;
  $("#scope-preset-name").value = state.scopePresets.find((preset) => preset.id === state.editingScopeId)?.name || "";
  renderScopePresets();
  $("#manual-board-details").open = !state.scopePresets.some((preset) => preset.id === state.activeScopeId);
  const initialized = await agentController.initialize(window.location.search);
  if (initialized?.command?.bridge && globalThis.ByrAgentBridge) {
    globalThis.agentBridgeConnection = ByrAgentBridge.connect(agentController.api, initialized.command.bridge, (status) => {
      const element = $("#agent-bridge-status");
      if (!element) return;
      element.textContent = status === "已连接" ? "Agent 已连接" : `Agent ${status}`;
      element.classList.toggle("is-connected", status === "已连接");
      const helpStatus = $("#agent-help-connection");
      if (helpStatus) {
        helpStatus.textContent = element.textContent;
        helpStatus.classList.toggle("is-connected", status === "已连接");
      }
    });
  }
}

init().catch((error) => { agentController.failInitialization(error); showToast(error.message || "初始化失败"); });
