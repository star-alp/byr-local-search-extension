/*
 * 邮人全搜论坛页面脚本：提供搜索入口，并定位、高亮搜索命中的帖子和文字。
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
      const retryAfterMs = globalThis.ByrForumClient?.retryAfterMs(response.headers.get("retry-after")) || 0;
      if (message.responseType === "text-gbk") {
        sendResponse({ ok: response.ok, status: response.status, retryAfterMs, text });
        return;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_error) {
        data = globalThis.ByrForumClient?.nonJsonData(text, response) || {
          success: false,
          code: "NON_JSON_RESPONSE",
          message: "论坛返回了非 JSON 内容"
        };
      }
      sendResponse({ ok: response.ok, status: response.status, retryAfterMs, data });
    })
    .catch((error) => sendResponse({ ok: false, status: 0, code: error.name === "AbortError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", error: error.name === "AbortError" ? "请求超时" : error.message }))
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
  let statusElement = null;

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
      .byr-search-jump-badge button,
      .byr-search-jump-status button {
        margin-left: 7px;
        border: 1px solid rgba(59, 37, 0, .45);
        border-radius: 3px;
        padding: 2px 5px;
        background: rgba(255, 255, 255, .6);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .byr-search-jump-status {
        position: fixed;
        right: 24px;
        bottom: 72px;
        z-index: 2147483645;
        max-width: min(360px, calc(100vw - 48px));
        border: 2px solid #d97706;
        border-radius: 6px;
        padding: 9px 11px;
        background: #fff7d6;
        color: #7a2200;
        box-shadow: 0 5px 16px rgba(23, 48, 56, .25);
        font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      ::highlight(byr-search-terms) {
        background-color: #ffe066;
        color: #7a2200;
        text-decoration: underline;
        text-decoration-color: #c45d00;
        text-decoration-thickness: 2px;
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
    const articleId = (params.get("byr_article_id") || "").trim();
    return { position, articleId, terms };
  };

  const removeStatus = () => {
    statusElement?.remove();
    statusElement = null;
  };

  const showStatus = (request) => {
    removeStatus();
    statusElement = document.createElement("div");
    statusElement.className = "byr-search-jump-status";
    statusElement.append(`未找到目标${request.position ? `（第 ${request.position} 楼）` : "帖子"}，可能还在加载。`);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新定位";
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      run();
    });
    statusElement.append(retry);
    document.body.appendChild(statusElement);
  };

  const clearHighlight = () => {
    window.CSS?.highlights?.delete("byr-search-terms");
    if (highlighted) {
      highlighted.classList.remove("byr-search-jump-highlight");
      const badge = highlighted.querySelector(":scope > .byr-search-jump-badge");
      badge?.remove();
      highlighted.style.position = previousPosition;
    }
    highlighted = null;
    previousPosition = "";
  };

  const highlightText = (request, target) => {
    if (!window.CSS?.highlights || !window.Highlight) return { firstRange: null, count: 0 };
    const terms = [...new Set(request.terms)].sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const ranges = [];
    // 只读取正文、作者账号和昵称，排除回复按钮、楼层标记等界面文字。
    const roots = target.querySelectorAll(".a-content-wrap, .a-u-name, .a-u-uid");
    if (terms.length) {
      const pattern = new RegExp(terms.join("|"), "giu");
      roots.forEach((root) => {
        const nodes = [];
        let text = "";
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => node.parentElement.closest("script, style, textarea, input, button, [contenteditable], [hidden]")
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
        });
        let node;
        while ((node = walker.nextNode())) {
          nodes.push({ node, start: text.length, end: text.length + node.length });
          text += node.data;
        }
        // 连续文字可以跨越内联标签，使用 Range 保留论坛原有 DOM 与事件。
        let index = 0;
        for (const match of text.matchAll(pattern)) {
          const end = match.index + match[0].length;
          while (nodes[index] && nodes[index].end <= match.index) index += 1;
          const startNode = nodes[index];
          if (!startNode) continue;
          while (nodes[index] && nodes[index].end < end) index += 1;
          const endNode = nodes[index];
          if (!endNode) continue;
          const range = document.createRange();
          range.setStart(startNode.node, match.index - startNode.start);
          range.setEnd(endNode.node, end - endNode.start);
          ranges.push(range);
        }
      });
    }
    window.CSS.highlights.set("byr-search-terms", new Highlight(...ranges));
    return { firstRange: ranges[0] || null, count: ranges.length };
  };

  const findTarget = (request) => {
    const posts = [...document.querySelectorAll(".a-wrap, article, .article-item, .topic-reply")];
    if (request.articleId) {
      const exact = posts.find((post) => [...post.querySelectorAll("a[href]")].some((link) => {
        const match = String(link.getAttribute("href") || "").match(/\/post\/([^/?#]+)/u);
        if (!match) return false;
        try {
          return decodeURIComponent(match[1]) === request.articleId;
        } catch (_error) {
          return match[1] === request.articleId;
        }
      }));
      // 传入回帖编号时只接受编号匹配，避免楼层变化后高亮另一条回帖。
      return exact || null;
    }
    // 主题链接定位楼主 a0；页面横幅也有 article 类名，不能用它寻找第一篇帖子。
    const position = request.position || "0";
    // nForum 旧版模板使用 <a name="a16"></a> 作为楼层锚点，不是 id 或 data-pos。
    const anchor = document.getElementById(`a${position}`)
      || document.querySelector(`[name="a${position}"]`)
      || document.querySelector(`[data-pos="${position}"]`);
    if (!anchor) return null;
    const wrappedPost = anchor.closest(".a-wrap, article, .article-item, .topic-reply");
    if (wrappedPost) return wrappedPost;
    // 论坛模板的楼层锚点与帖子容器是兄弟节点：<a name="a16"></a><div class="a-wrap">…。
    const sibling = anchor.nextElementSibling;
    if (sibling?.matches(".a-wrap, article, .article-item, .topic-reply")) return sibling;
    if (sibling?.matches("table.article")) return sibling;
    const siblingPost = sibling?.querySelector(".a-wrap, article, .article-item, .topic-reply, table.article");
    return siblingPost || null;
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
    target.appendChild(badge);
    const matchResult = highlightText(request, target);
    const firstMatch = matchResult?.firstRange || null;
    const matchCount = matchResult?.count || 0;
    const summary = request.position ? `第 ${request.position} 楼` : "主题帖";
    const label = request.terms.length
      ? (matchCount ? `搜索命中 · ${summary} · ${matchCount} 处` : `已定位 · ${summary} · 本页未找到关键词`)
      : `已定位 · ${summary}`;
    badge.textContent = label;
    if (request.terms.length && !matchCount) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新定位";
      retry.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); run(); });
      badge.append(retry);
    }
    const rect = firstMatch?.getBoundingClientRect();
    if (rect?.height) {
      window.scrollBy({ top: rect.top - Math.max(96, window.innerHeight * 0.35), behavior: "smooth" });
    } else target.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const run = () => {
    if (observer) observer.disconnect();
    window.clearTimeout(timer);
    clearHighlight();
    const request = requestFromHash();
    removeStatus();
    if (!request || (!request.position && !request.articleId && !request.terms.length)) return;
    const attempt = () => {
      const target = findTarget(request);
      if (!target) return false;
      if (target === highlighted) {
        highlightText(request, target);
        return true;
      }
      applyHighlight(request, target);
      return true;
    };
    // 单页路由可能先显示旧内容再替换，继续观察，直到真正的帖子容器渲染完成。
    attempt();
    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    const timeoutMs = Number(globalThis.byrSearchJumpTimeoutMs) || 15000;
    timer = window.setTimeout(() => {
      observer?.disconnect();
      if (!highlighted?.isConnected) showStatus(request);
    }, timeoutMs);
  };

  window.addEventListener("hashchange", run);
  run();
}

installByrJumpHighlight();
})();
