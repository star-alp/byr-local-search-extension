/* 邮人全搜论坛请求分类：把登录、失效主题、限流和非 JSON 响应统一成可处理的错误。 */

(function installByrForumClient() {
  if (globalThis.ByrForumClient) return;

  class ForumRequestError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "ForumRequestError";
      Object.assign(this, details);
    }
  }

  const ERROR_MESSAGES = Object.freeze({
    LOGIN_REQUIRED: "尚未登录论坛或登录已失效，请点击右上角“打开论坛登录”，登录后重试",
    THREAD_NOT_FOUND: "主题不存在或主题数据无效",
    RATE_LIMITED: "论坛请求过于频繁，请稍后重试",
    REQUEST_TIMEOUT: "论坛请求超时，请稍后重试",
    NETWORK_ERROR: "论坛网络连接中断，请检查网络后重试",
    SERVER_BUSY: "论坛服务器暂时繁忙，请稍后重试",
    NON_JSON_RESPONSE: "论坛返回的数据格式异常，请刷新论坛页面后重试",
    PAGE_CONNECTION_FAILED: "无法连接论坛页面，请先打开论坛并登录，再刷新论坛页面后重试",
    EXTENSION_RELOADED: "插件已更新或重新加载，请刷新论坛页面并重新打开插件",
    PERMISSION_DENIED: "当前无法访问此内容，请确认已登录且账号有访问权限",
    STORAGE_FULL: "浏览器本地存储空间不足，请在“更多设置”中检查插件资源",
    STORAGE_ERROR: "无法读写本地数据，请关闭旧版插件标签页后重新打开"
  });

  function messageCode(message) {
    if (/未登录|请登录|登录后|尚未登录|登录已失效|\b(?:not[ _-]?(?:logged[ _-]?in|login|signed[ _-]?in)|unauthenticated|unauthori[sz]ed)\b|\b(?:please|must|need\s+to|have\s+to|haven['’]?t)\s+(?:log(?:ged)?\s*in|login|sign\s*in)\b|\b(?:login|log\s*in|sign\s*in)[ _-]?(?:required|first)\b|\bsession\s+(?:has\s+)?(?:expired|invalid)\b/iu.test(message)) return "LOGIN_REQUIRED";
    if (/指定的文章不存在|文章不存在|链接错误|sys exception:[\s\S]*threads\.php/iu.test(message)) return "THREAD_NOT_FOUND";
    if (/too many|rate.?limit|频繁|限流/iu.test(message)) return "RATE_LIMITED";
    if (/请求超时|\b(?:timed?\s*out|timeout)\b/iu.test(message)) return "REQUEST_TIMEOUT";
    if (/extension context invalidated|extension.*(?:reloaded|updated)/iu.test(message)) return "EXTENSION_RELOADED";
    if (/receiving end does not exist|could not establish connection|message (?:port|channel).*closed|no tab with id|frame.*(?:removed|not found)|cannot access contents of (?:the )?(?:url|page)/iu.test(message)) return "PAGE_CONNECTION_FAILED";
    if (/failed to fetch|networkerror|network request failed|load failed|err_(?:network|internet|connection)/iu.test(message)) return "NETWORK_ERROR";
    if (/quota.*exceed|storage.*full/iu.test(message)) return "STORAGE_FULL";
    if (/indexeddb|idbdatabase|idbtransaction|database.*(?:closed|error)|transaction.*(?:abort|inactive)|object store.*not found/iu.test(message)) return "STORAGE_ERROR";
    if (/\bforbidden\b|permission denied|access denied/iu.test(message)) return "PERMISSION_DENIED";
    return "";
  }

  function userMessage(value, fallback = "操作未完成，请刷新页面后重试") {
    const message = String(value?.message || value || "").trim();
    const code = ERROR_MESSAGES[value?.code] ? value.code : messageCode(message);
    if (code) return ERROR_MESSAGES[code];
    return /[\u3400-\u9fff]/u.test(message) ? message : fallback;
  }

  function errorFromResponse(response, fallback = "论坛请求失败") {
    const data = response?.data || {};
    const message = String(data.message || response?.error || fallback);
    const preview = String(data.preview || "").trim();
    const status = Number(response?.status) || 0;
    const lower = `${data.code || response?.code || ""} ${message} ${preview}`;
    let code = data.code || response?.code || "FORUM_REQUEST_FAILED";
    const detected = messageCode(lower);
    if (status === 401 || detected === "LOGIN_REQUIRED") code = "LOGIN_REQUIRED";
    else if (detected === "THREAD_NOT_FOUND") code = "THREAD_NOT_FOUND";
    else if (status === 429 || detected === "RATE_LIMITED") code = "RATE_LIMITED";
    else if (status === 408 || detected === "REQUEST_TIMEOUT") code = "REQUEST_TIMEOUT";
    else if (status >= 500 && status <= 599) code = "SERVER_BUSY";
    else if (detected) code = detected;
    else if (status === 403) code = "PERMISSION_DENIED";
    else if (data.code === "NON_JSON_RESPONSE") code = "NON_JSON_RESPONSE";
    return new ForumRequestError(userMessage({ code, message }, fallback), {
      code,
      status,
      originalMessage: message,
      retryAfterMs: Math.max(0, Number(response?.retryAfterMs) || 0),
      preview,
      contentType: String(data.contentType || "")
    });
  }

  function isThreadUnavailable(error) {
    return error?.code === "THREAD_NOT_FOUND";
  }

  function retryAfterMs(value, now = Date.now()) {
    if (!value) return 0;
    const seconds = Number(value);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
  }

  function isRetryable(error) {
    return ["RATE_LIMITED", "REQUEST_TIMEOUT", "NETWORK_ERROR", "SERVER_BUSY"].includes(error?.code);
  }

  function createRequestPolicy() {
    let penalty = 0;
    let failures = 0;
    let successes = 0;
    let lastFailureAt = 0;
    let cooldownUntil = 0;
    return {
      limits(concurrency, delayMs) {
        return {
          concurrency: Math.max(1, Math.floor(concurrency / 2 ** penalty)),
          delayMs: Math.max(delayMs, penalty ? 250 * 2 ** (penalty - 1) : 0),
          reduced: penalty > 0,
          cooldownUntil
        };
      },
      failed(error, attempt, now = Date.now()) {
        if (!isRetryable(error)) return 0;
        failures += 1;
        successes = 0;
        lastFailureAt = now;
        if (error.code === "RATE_LIMITED" || failures >= 2) {
          penalty = Math.min(3, penalty + 1);
          failures = 0;
        }
        const delay = Math.max(error.retryAfterMs || 0, (error.code === "RATE_LIMITED" ? 2000 : 500) * 2 ** attempt);
        cooldownUntil = Math.max(cooldownUntil, now + delay);
        return delay;
      },
      succeeded(now = Date.now()) {
        failures = 0;
        successes += 1;
        if (penalty && successes >= 12 && now - lastFailureAt >= 5000 && now >= cooldownUntil) {
          penalty -= 1;
          successes = 0;
        }
      }
    };
  }

  function nonJsonData(text, response) {
    const preview = String(text || "").trim().replace(/\s+/gu, " ").slice(0, 240);
    const invalidThread = /sys exception:[\s\S]*threads\.php|指定的文章不存在|文章不存在|链接错误/iu.test(text);
    const code = invalidThread ? "THREAD_NOT_FOUND" : messageCode(preview) === "LOGIN_REQUIRED" ? "LOGIN_REQUIRED" : "NON_JSON_RESPONSE";
    return {
      success: false,
      code,
      message: ERROR_MESSAGES[code],
      contentType: response?.headers?.get?.("content-type") || "",
      preview
    };
  }

  globalThis.ByrForumClient = Object.freeze({ ForumRequestError, errorFromResponse, isThreadUnavailable, nonJsonData, retryAfterMs, isRetryable, createRequestPolicy, userMessage });
})();
