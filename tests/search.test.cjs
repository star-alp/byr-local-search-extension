/* 邮人全搜行为回归测试：验证增量任务、暂停恢复、局部失败重试和完整正文保护。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
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
    document, URL, URLSearchParams, DOMException, structuredClone, Blob,
    window: { location: { search: "" }, setTimeout, clearTimeout },
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { async sendMessage() { throw new Error("不应发出请求"); } } }
  });
  const source = fs.readFileSync(path.join(root, "search.js"), "utf8").replace(/init\(\)\.catch\([\s\S]*$/, "");
  vm.runInContext(source + "\nglobalThis.api = { state, mergeDocument, requestApi, addOnlineDocument, matchDocument, searchDocuments, compareResults, userResults, renderResults, groupDocumentResults, queryGroups, nativeSearchPaths, highlight, rememberSessionPage, getSessionPage, mergeOnlineDocuments };", context);
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
