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
    let code = data.code || "FORUM_REQUEST_FAILED";
    if (status === 401 || /未登录|请登录|登录后/iu.test(lower)) code = "LOGIN_REQUIRED";
    else if (/指定的文章不存在|文章不存在|链接错误|sys exception:[\s\S]*threads\.php/iu.test(lower)) code = "THREAD_NOT_FOUND";
    else if (status === 429 || /too many|rate.?limit|频繁|限流/iu.test(lower)) code = "RATE_LIMITED";
    else if (data.code === "NON_JSON_RESPONSE") code = "NON_JSON_RESPONSE";
    const labels = {
      LOGIN_REQUIRED: "论坛登录已失效，请先在论坛页面重新登录",
      THREAD_NOT_FOUND: "主题不存在或主题数据无效",
      RATE_LIMITED: "论坛请求过于频繁，请稍后重试",
      NON_JSON_RESPONSE: "论坛返回了非 JSON 内容"
    };
    return new ForumRequestError(labels[code] || message, {
      code,
      status,
      preview,
      contentType: String(data.contentType || "")
    });
  }

  function isThreadUnavailable(error) {
    return error?.code === "THREAD_NOT_FOUND";
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

  globalThis.ByrForumClient = Object.freeze({ ForumRequestError, errorFromResponse, isThreadUnavailable, nonJsonData });
})();
