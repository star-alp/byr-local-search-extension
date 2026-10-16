/* 邮人全搜本地 Agent CLI：通过 Chrome DevTools Protocol 调用已打开的扩展页面，不需要扩展监听本地端口。 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const AGENT_GLOBAL = "__BYR_LOCAL_SEARCH_AGENT_V1__";

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const options = { command: first && !first.startsWith("-") ? first : "capabilities" };
  const values = first && !first.startsWith("-") ? rest : argv;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") { options.help = true; continue; }
    if (!value.startsWith("--")) throw new Error(`无法识别参数：${value}`);
    const equal = value.indexOf("=");
    const key = equal >= 0 ? value.slice(2, equal) : value.slice(2);
    if (!key) throw new Error("参数名称不能为空");
    if (equal >= 0) options[key] = value.slice(equal + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) options[key] = values[++index];
    else options[key] = true;
  }
  return options;
}

function numberOption(options, name, fallback, min, max) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} 必须是 ${min}～${max} 的整数`);
  return value;
}

function cliHelp() {
  return `邮人全搜 Agent CLI（Node.js 22 或更高版本）

用法：
  node agent-cli.mjs capabilities [--port 9222]
  node agent-cli.mjs search --query "<关键词>" [--mode online] [--scope last-used] [--wait]
  node agent-cli.mjs status [--port 9222]
  node agent-cli.mjs results [--cursor <游标>] [--limit 20]
  node agent-cli.mjs scopes | boards [--query <版面名称或 ID>]
  node agent-cli.mjs cancel --search-id <搜索标识>

常用参数：
  --port 9222       Chrome DevTools Protocol 本地端口
  --url <扩展 URL>  没有已打开的搜索页时尝试新建扩展页面
  --wait            搜索命令等待完成并输出最终结果
  --pretty          美化 JSON 输出
  --query <关键词>  搜索关键词；请使用引号包住包含空格的内容
`;
}

function output(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`无法读取 Chrome 调试目标（HTTP ${response.status}）`);
  return response.json();
}

async function openTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome 未允许通过调试接口打开扩展页面（HTTP ${response.status}）`);
  return response.json();
}

async function findTarget(port, url) {
  let targets = await listTargets(port);
  const matches = (target) => target.type === "page"
    && target.webSocketDebuggerUrl
    && (url ? target.url === url : /\/search\.html(?:\?|$)/u.test(target.url || ""));
  let target = targets.find(matches);
  if (!target && url) {
    target = await openTarget(port, url);
  }
  if (!target) throw new Error("未找到邮人全搜搜索页；请先打开扩展页面，或用 --url 提供扩展 URL");
  return target;
}

function connectDebugger(url) {
  if (typeof WebSocket !== "function") throw new Error("当前 Node.js 没有内置 WebSocket，请使用 Node.js 22 或更高版本");
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接 Chrome 调试目标")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message || "Chrome 调试命令失败"));
    else callback.resolve(message);
  });
  socket.addEventListener("close", () => {
    for (const callback of pending.values()) callback.reject(new Error("Chrome 调试连接已关闭"));
    pending.clear();
  });
  return {
    async evaluate(expression) {
      await ready;
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      const result = response.result?.result;
      if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || "扩展页面执行失败");
      if (result?.subtype === "error") throw new Error(result.description || "扩展页面执行失败");
      return result?.value;
    },
    close() { socket.close(); }
  };
}

async function invoke(debuggerClient, method, argument) {
  const encoded = argument === undefined ? "undefined" : JSON.stringify(argument);
  const expression = `(async()=>{const agent=globalThis[${JSON.stringify(AGENT_GLOBAL)}];if(!agent)throw new Error("未找到邮人全搜 Agent API");return await agent[${JSON.stringify(method)}](${encoded});})()`;
  const result = await debuggerClient.evaluate(expression);
  if (!result?.ok) throw new Error(result?.error?.message || `${method} 调用失败`);
  return result;
}

function searchOptions(options) {
  const fields = ["query", "mode", "scope", "boardPages", "threadPages", "timeRange", "dateFrom", "dateTo", "persist", "confirm"];
  const result = {};
  for (const field of fields) {
    const flag = field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    if (options[field] !== undefined) result[field] = options[field];
    else if (options[flag] !== undefined) result[field] = options[flag];
  }
  if (options.boards !== undefined) result.boards = String(options.boards).split(",").map((name) => name.trim()).filter(Boolean);
  for (const field of ["persist", "confirm"]) if (result[field] !== undefined) result[field] = result[field] === true || result[field] === "1" || result[field] === "true";
  for (const field of ["boardPages", "threadPages"]) if (result[field] !== undefined) result[field] = result[field] === "all" ? null : Number(result[field]);
  return result;
}

function applyChanges(results, items) {
  for (const item of items) {
    if (item.operation === "remove") results.delete(item.id);
    else results.set(item.id, item);
  }
}

async function waitForResults(client, start, options) {
  const results = new Map();
  let cursor;
  let latest;
  const limit = numberOption(options, "limit", 100, 1, 100);
  while (true) {
    const page = await invoke(client, "getResults", { ...(cursor ? { cursor } : {}), limit });
    latest = page;
    applyChanges(results, page.items || []);
    cursor = page.nextCursor;
    if (options.progress) process.stderr.write(`搜索状态：${page.status} · 已找到 ${page.total} 条\n`);
    if (!page.running && !page.hasMore) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const status = await invoke(client, "getStatus");
  return { ok: true, searchId: start.searchId || latest.searchId, status, total: results.size, results: [...results.values()] };
}

async function run(options) {
  if (options.help) { process.stdout.write(cliHelp()); return; }
  const port = numberOption(options, "port", 9222, 1, 65535);
  const target = await findTarget(port, options.url);
  const client = connectDebugger(target.webSocketDebuggerUrl);
  try {
    if (options.command === "search") {
      const start = await invoke(client, "startSearch", searchOptions(options));
      if (options.wait || options.watch) output(await waitForResults(client, start, options), options.pretty);
      else output(start, options.pretty);
      return;
    }
    if (options.command === "results") {
      const limit = numberOption(options, "limit", 20, 1, 100);
      output(await invoke(client, "getResults", { ...(options.cursor ? { cursor: options.cursor } : {}), limit }), options.pretty);
      return;
    }
    if (options.command === "cancel") {
      if (!options["search-id"]) throw new Error("cancel 需要 --search-id");
      output(await invoke(client, "cancelSearch", { searchId: options["search-id"] }), options.pretty);
      return;
    }
    const methods = { capabilities: "getCapabilities", status: "getStatus", scopes: "listScopes", boards: "listBoards" };
    const method = methods[options.command];
    if (!method) throw new Error(`无法识别命令：${options.command}`);
    const argument = options.command === "boards" && options.query ? { query: options.query } : undefined;
    output(await invoke(client, method, argument), options.pretty);
  } finally {
    client.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    await run(parseArgs(argv));
  } catch (error) {
    output({ ok: false, error: { message: error.message || "CLI 调用失败" } });
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();

export { applyChanges, parseArgs, searchOptions, waitForResults };
