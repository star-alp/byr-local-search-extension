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

  function errorFromResponse(response, fallback = "论坛请求失败") {
    const data = response?.data || {};
    const message = String(data.message || response?.error || fallback);
    const preview = String(data.preview || "").trim();
    const status = Number(response?.status) || 0;
    const lower = `${message} ${preview}`;
    let code = data.code || response?.code || "FORUM_REQUEST_FAILED";
    if (status === 401 || /未登录|请登录|登录后/iu.test(lower)) code = "LOGIN_REQUIRED";
    else if (/指定的文章不存在|文章不存在|链接错误|sys exception:[\s\S]*threads\.php/iu.test(lower)) code = "THREAD_NOT_FOUND";
    else if (status === 429 || /too many|rate.?limit|频繁|限流/iu.test(lower)) code = "RATE_LIMITED";
    else if (status === 408 || /请求超时/iu.test(lower)) code = "REQUEST_TIMEOUT";
    else if (status >= 500 && status <= 599) code = "SERVER_BUSY";
    else if (data.code === "NON_JSON_RESPONSE") code = "NON_JSON_RESPONSE";
    const labels = {
      LOGIN_REQUIRED: "论坛登录已失效，请先在论坛页面重新登录",
      THREAD_NOT_FOUND: "主题不存在或主题数据无效",
      RATE_LIMITED: "论坛请求过于频繁，请稍后重试",
      REQUEST_TIMEOUT: "论坛请求超时",
      NETWORK_ERROR: "论坛网络连接中断",
      SERVER_BUSY: "论坛服务器暂时繁忙",
      NON_JSON_RESPONSE: "论坛返回了非 JSON 内容"
    };
    return new ForumRequestError(labels[code] || message, {
      code,
      status,
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
    return {
      success: false,
      code: invalidThread ? "THREAD_NOT_FOUND" : "NON_JSON_RESPONSE",
      message: invalidThread ? "主题不存在或主题数据无效" : "论坛返回了非 JSON 内容",
      contentType: response?.headers?.get?.("content-type") || "",
      preview
    };
  }

  globalThis.ByrForumClient = Object.freeze({ ForumRequestError, errorFromResponse, isThreadUnavailable, nonJsonData, retryAfterMs, isRetryable, createRequestPolicy });
})();
