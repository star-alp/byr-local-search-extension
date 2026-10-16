/* 邮人全搜 Agent CLI 回归测试：验证命令解析、参数转换和增量结果合并。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("Agent CLI 帮助信息可直接从 Node.js 输出", () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const result = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Chrome DevTools Protocol/);
  assert.match(result.stdout, /node agent-cli\.mjs search/);
});

test("Agent CLI 将命令参数转换为扩展 API 参数", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { parseArgs, searchOptions } = await import(`file://${file}`);
  const parsed = parseArgs(["search", "--query", "<关键词>", "--mode=online", "--board-pages", "all", "--persist", "1", "--boards", "A,B"]);
  assert.equal(parsed.command, "search");
  assert.deepEqual(searchOptions(parsed), { query: "<关键词>", mode: "online", boardPages: null, persist: true, boards: ["A", "B"] });
});

test("Agent CLI 合并 upsert 和 remove 增量结果", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { applyChanges } = await import(`file://${file}`);
  const results = new Map([["a", { id: "a", title: "旧标题" }]]);
  applyChanges(results, [{ id: "a", operation: "upsert", title: "新标题" }, { id: "b", operation: "upsert", title: "新增" }]);
  assert.equal(results.get("a").title, "新标题");
  assert.equal(results.size, 2);
  applyChanges(results, [{ id: "a", operation: "remove" }]);
  assert.deepEqual([...results.keys()], ["b"]);
});
