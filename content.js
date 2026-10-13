/*
 * 邮人全搜论坛页面脚本：在论坛页面增加一个打开本地搜索页的入口。
 * 账号登录由用户自己完成，数据请求由扩展后台使用现有浏览器登录态完成。
 * JSON 接口与论坛原生 GBK 搜索页均只读取响应，不读取或保存 Cookie 值。
 */

(function installByrSearchContent() {
  if (window.top !== window.self || globalThis.byrSearchContentInstalled) return;
  globalThis.byrSearchContentInstalled = true;

(function installByrSearchLauncher() {
  if (window.top !== window.self) {
    return;
  }

  const button = document.getElementById("byr-local-search-launcher") || document.createElement("button");
  button.id = "byr-local-search-launcher";
  button.type = "button";
  button.textContent = "邮人全搜";
  Object.assign(button.style, {
    position: "fixed",
    right: "24px",
    bottom: "24px",
    zIndex: "2147483646",
    border: "0",
    borderRadius: "7px",
    padding: "10px 15px",
    background: "#1d6475",
    color: "#ffffff",
    font: "600 14px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxShadow: "0 5px 16px rgba(23, 48, 56, 0.25)",
    cursor: "pointer"
  });
  button.addEventListener("mouseenter", () => { button.style.background = "#174f5d"; });
  button.addEventListener("mouseleave", () => { button.style.background = "#1d6475"; });
  button.onclick = () => {
    chrome.runtime.sendMessage({ type: "open-search" });
  };
  document.documentElement.appendChild(button);
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "fetch-api") {
    return false;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  fetch(message.path, {
    credentials: "include",
    headers: {
      Accept: message.responseType === "text-gbk" ? "text/html" : "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    signal: controller.signal
  })
    .then(async (response) => {
      const buffer = await response.arrayBuffer();
      const text = message.responseType === "text-gbk"
        ? new TextDecoder("gbk").decode(buffer)
        : new TextDecoder("utf-8").decode(buffer);
      if (message.responseType === "text-gbk") {
        sendResponse({ ok: response.ok, status: response.status, text });
        return;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_error) {
        data = { success: false, message: "论坛返回了非 JSON 内容" };
      }
      sendResponse({ ok: response.ok, status: response.status, data });
    })
    .catch((error) => sendResponse({ ok: false, status: 0, error: error.name === "AbortError" ? "请求超时" : error.message }))
    .finally(() => window.clearTimeout(timeout));

  return true;
});

function installByrJumpHighlight() {
  if (globalThis.byrSearchJumpHighlightInstalled) return;
  globalThis.byrSearchJumpHighlightInstalled = true;
  let observer = null;
  let timer = null;
  let highlighted = null;
  let previousPosition = "";

  const ensureStyle = () => {
    if (document.getElementById("byr-search-jump-style")) return;
    const style = document.createElement("style");
    style.id = "byr-search-jump-style";
    style.textContent = `
      @keyframes byr-search-jump-pulse {
        0%, 100% { box-shadow: 0 0 0 3px rgba(245, 158, 11, .22), 0 0 0 0 rgba(245, 158, 11, .35); }
        50% { box-shadow: 0 0 0 6px rgba(245, 158, 11, .34), 0 0 0 13px rgba(245, 158, 11, 0); }
      }
      .byr-search-jump-highlight {
        z-index: 2 !important;
        outline: 3px solid #f59e0b !important;
        outline-offset: 3px !important;
        background-color: #fff7d6 !important;
        animation: byr-search-jump-pulse 1.2s ease-in-out 3;
        scroll-margin-block: 96px;
      }
      .byr-search-jump-badge {
        position: absolute;
        top: 7px;
        right: 8px;
        z-index: 3;
        border-radius: 4px;
        padding: 3px 7px;
        background: #f59e0b;
        color: #3b2500;
        font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
    `;
    document.head.appendChild(style);
  };

  const requestFromHash = () => {
    const hash = String(window.location.hash || "");
    if (!hash.startsWith("#!article/")) return null;
    const route = hash.slice(2);
    const [pathAndQuery, anchor] = route.split("#", 2);
    const queryIndex = pathAndQuery.indexOf("?");
    const params = new URLSearchParams(queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : "");
    const position = anchor?.match(/^a(\d+)$/u)?.[1] || "";
    const terms = (params.get("byr_highlight") || "").split("|").filter(Boolean).slice(0, 8);
    return { position, terms };
  };

  const clearHighlight = () => {
    if (highlighted) {
      highlighted.classList.remove("byr-search-jump-highlight");
      const badge = highlighted.querySelector(":scope > .byr-search-jump-badge");
      badge?.remove();
      highlighted.style.position = previousPosition;
    }
    highlighted = null;
    previousPosition = "";
  };

  const findTarget = (request) => {
    if (request.position) {
      // nForum 旧版模板使用 <a name="a16"></a> 作为楼层锚点，不是 id 或 data-pos。
      const anchor = document.getElementById(`a${request.position}`)
        || document.querySelector(`[name="a${request.position}"]`)
        || document.querySelector(`[data-pos="${request.position}"]`);
      if (anchor) return anchor.closest("article, .article, .article-item, .topic-reply, li, tr") || anchor.parentElement;
    }
    return document.querySelector("article, .article, .article-item, .topic-reply");
  };

  const applyHighlight = (request, target) => {
    clearHighlight();
    ensureStyle();
    highlighted = target;
    previousPosition = target.style.position;
    if (getComputedStyle(target).position === "static") target.style.position = "relative";
    target.classList.add("byr-search-jump-highlight");
    const badge = document.createElement("span");
    badge.className = "byr-search-jump-badge";
    badge.textContent = request.position ? `搜索命中 · 第 ${request.position} 楼` : "搜索命中";
    target.appendChild(badge);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const run = () => {
    if (observer) observer.disconnect();
    window.clearTimeout(timer);
    clearHighlight();
    const request = requestFromHash();
    if (!request || (!request.position && !request.terms.length)) return;
    const attempt = () => {
      const target = findTarget(request);
      if (!target) return false;
      applyHighlight(request, target);
      return true;
    };
    if (attempt()) return;
    observer = new MutationObserver(() => { if (attempt()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => observer?.disconnect(), 15000);
  };

  window.addEventListener("hashchange", run);
  run();
}

installByrJumpHighlight();
})();
