/* 邮人全搜扩展侧 Bridge 客户端：由扩展页面主动连接本机 Bridge，并转发已有 Agent API 调用。 */

globalThis.ByrAgentBridge = (() => {
  const ALLOWED_METHODS = new Set(["getCapabilities", "getStatus", "getContext", "previewSearch", "listScopes", "listBoards", "startSearch", "getResults", "pauseSearch", "resumeSearch", "retrySearch", "cancelSearch"]);

  function connect(api, options, onStatus = () => {}) {
    const port = Number(options?.port);
    const token = String(options?.token || "");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Bridge 端口无效");
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("Bridge 令牌无效");
    let socket;
    let stopped = false;
    let retryTimer = 0;
    const connectSocket = () => {
      if (stopped) return;
      onStatus("连接中");
      socket = new WebSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${encodeURIComponent(token)}`);
      socket.addEventListener("open", () => {
        onStatus("已连接");
        socket.send(JSON.stringify({ type: "hello", role: "extension", protocolVersion: 1 }));
      }, { once: true });
      socket.addEventListener("message", async (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== "request") return;
        if (!ALLOWED_METHODS.has(message.method)) {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", id: message.id || "", result: { ok: false, apiVersion: 1, error: { code: "METHOD_NOT_FOUND", message: "扩展 Agent API 不支持此方法" } } }));
          return;
        }
        let result;
        try {
          const method = api[message.method];
          if (typeof method !== "function") throw Object.assign(new Error("扩展 Agent API 不支持此方法"), { code: "METHOD_NOT_FOUND" });
          result = await method(message.argument);
        } catch (error) {
          result = { ok: false, apiVersion: 1, error: { code: error.code || "BRIDGE_CLIENT_ERROR", message: error.message || "扩展调用失败" } };
        }
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", id: message.id, result }));
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        onStatus("未连接");
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connectSocket, 1500);
      }, { once: true });
      socket.addEventListener("error", () => onStatus("连接失败"), { once: true });
    };
    connectSocket();
    return {
      close() {
        stopped = true;
        window.clearTimeout(retryTimer);
        socket?.close();
        onStatus("已断开");
      }
    };
  }

  return Object.freeze({ connect });
})();
