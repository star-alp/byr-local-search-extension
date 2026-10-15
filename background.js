/*
 * 邮人全搜扩展后台脚本：打开本地搜索页，并使用浏览器现有登录态请求论坛只读接口。
 * 扩展不读取或保存用户密码、Cookie 值，也不会把论坛响应发送到第三方服务器。
 */

importScripts("forum-client.js");

const SEARCH_PAGE = chrome.runtime.getURL("search.html");

async function findForumTab(sourceTabId) {
  if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
    try {
      const tab = await chrome.tabs.get(sourceTabId);
      if (tab.url && new URL(tab.url).origin === "https://bbs.byr.cn") return tab;
    } catch (_error) {
      // 来源标签关闭或无效时，寻找其他论坛标签。
    }
  }
  const tabs = await chrome.tabs.query({ url: "https://bbs.byr.cn/*" });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (!tabs.length) throw new Error("请先在当前 Chrome 用户中打开北邮人论坛并登录，再点击“从论坛读取/刷新版面”");
  return tabs[0];
}

async function fetchViaForumPage(sourceTabId, message) {
  const tab = await findForumTab(sourceTabId);
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/iu.test(error.message || "")) throw error;
    // 扩展重载后，已打开的论坛页面可能还没有当前版本的内容脚本。
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["forum-client.js", "content.js"] });
    response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  }
  return { ...response, sourceTabId: tab.id };
}

function openSearchPage(sourceTabId) {
  const query = Number.isInteger(sourceTabId) ? `?sourceTabId=${sourceTabId}` : "";
  return chrome.tabs.create({ url: `${SEARCH_PAGE}${query}` });
}

chrome.action.onClicked.addListener((tab) => {
  openSearchPage(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "open-search") {
    openSearchPage(sender.tab?.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type !== "api-via-page") {
    return false;
  }

  const sourceTabId = Number(message.sourceTabId);
  const path = typeof message.path === "string" ? message.path : "";
  let requestUrl;
  try {
    requestUrl = new URL(path, "https://bbs.byr.cn");
  } catch (_error) {
    requestUrl = null;
  }
  const isBoardApi = requestUrl?.pathname.startsWith("/n/b/");
  const isNativeSearch = requestUrl?.pathname === "/s/article";
  const allowedSearchParams = new Set(["b", "t1", "t2", "tn", "au", "d", "p"]);
  const hasUnexpectedSearchParam = isNativeSearch
    && [...requestUrl.searchParams.keys()].some((key) => !allowedSearchParams.has(key));
  if (!requestUrl
      || requestUrl.origin !== "https://bbs.byr.cn"
      || (!isBoardApi && !isNativeSearch)
      || hasUnexpectedSearchParam
      || path.includes("..")) {
    sendResponse({ ok: false, error: "请求路径或来源页面无效" });
    return false;
  }

  fetchViaForumPage(sourceTabId, {
    type: "fetch-api",
    path: `${requestUrl.pathname}${requestUrl.search}`,
    responseType: isNativeSearch ? "text-gbk" : "json"
  })
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      status: 0,
      error: ByrForumClient.userMessage(error, "无法连接论坛页面，请刷新论坛页面后重试")
    }));
  return true;
});
