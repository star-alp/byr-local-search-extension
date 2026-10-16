/* 邮人全搜 Agent Bridge 回归测试：验证本机回环 WebSocket 的鉴权与请求转发。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const TOKEN = "0123456789abcdef0123456789abcdef";

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "agent-cli.mjs"), ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Agent Bridge 只转发已认证的扩展请求并返回结果", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  const agent = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  const extensionMessages = [];
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    extensionMessages.push(message);
    if (message.type === "request") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, method: message.method, argument: message.argument } }));
  });
  agent.send(JSON.stringify({ type: "request", id: "request-1", method: "getStatus", argument: undefined }));
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 请求超时")), 1000);
    agent.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== "request-1") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  assert.deepEqual(response.result, { ok: true, apiVersion: 1, method: "getStatus" });
  assert.equal(extensionMessages.some((message) => message.type === "request" && message.method === "getStatus"), true);
  const health = await (await fetch(`http://127.0.0.1:${port}/health?token=${TOKEN}`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.extensionConnected, true);
  assert.equal(health.agentConnected, true);
  agent.send(JSON.stringify({ type: "request", id: "request-invalid", method: "readCookies" }));
  const invalid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 未拒绝未知方法")), 1000);
    agent.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== "request-invalid") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  assert.equal(invalid.result.error.code, "INVALID_REQUEST");
  extension.close();
  agent.close();
  await bridge.close();
});

test("Agent CLI 可以通过 Bridge 调用扩展 API", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "request") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, bridge: true } }));
  });
  const result = await runCli(["capabilities", "--transport", "bridge", "--port", String(port), "--token", TOKEN]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bridge, true);
  extension.close();
  await bridge.close();
});
