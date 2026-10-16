/* 邮人全搜论坛请求分类：统一处理请求错误，并支持中英双语及多语言提示。 */

(function installByrForumClient() {
  if (globalThis.ByrForumClient) return;

  class ForumRequestError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = "ForumRequestError";
      Object.assign(this, details);
    }
  }

  const SUPPORTED_LANGUAGES = Object.freeze([
    { id: "zh-CN", label: "简体中文" },
    { id: "zh-en", label: "中文 / English" },
    { id: "en", label: "English" },
    { id: "ja", label: "日本語" },
    { id: "ko", label: "한국어" },
    { id: "ru", label: "Русский" }
  ]);
  const ERROR_MESSAGES = Object.freeze({
    LOGIN_REQUIRED: {
      "zh-CN": "尚未登录论坛或登录已失效，请点击右上角“打开论坛登录”，登录后重试",
      en: "You are not logged in to the forum, or your login has expired. Open forum login and try again.",
      ja: "フォーラムにログインしていないか、ログインの有効期限が切れています。フォーラムのログイン画面を開いて再試行してください。",
      ko: "포럼에 로그인하지 않았거나 로그인이 만료되었습니다. 포럼 로그인 화면을 열고 다시 시도하세요.",
      ru: "Вы не вошли на форум или срок входа истёк. Откройте вход на форум и повторите попытку."
    },
    THREAD_NOT_FOUND: { "zh-CN": "主题不存在或主题数据无效", en: "The topic does not exist or its data is invalid.", ja: "スレッドが存在しないか、データが無効です。", ko: "게시글이 없거나 데이터가 올바르지 않습니다.", ru: "Тема не существует или её данные недействительны." },
    RATE_LIMITED: { "zh-CN": "论坛请求过于频繁，请稍后重试", en: "Forum requests are being sent too frequently. Try again later.", ja: "フォーラムへのリクエストが多すぎます。しばらくしてから再試行してください。", ko: "포럼 요청이 너무 많습니다. 잠시 후 다시 시도하세요.", ru: "Запросы к форуму поступают слишком часто. Повторите попытку позже." },
    REQUEST_TIMEOUT: { "zh-CN": "论坛请求超时，请稍后重试", en: "The forum request timed out. Try again later.", ja: "フォーラムへのリクエストがタイムアウトしました。後でもう一度お試しください。", ko: "포럼 요청 시간이 초과되었습니다. 잠시 후 다시 시도하세요.", ru: "Время ожидания запроса к форуму истекло. Повторите попытку позже." },
    NETWORK_ERROR: { "zh-CN": "论坛网络连接中断，请检查网络后重试", en: "The forum network connection was interrupted. Check your network and try again.", ja: "フォーラムへのネットワーク接続が中断されました。接続を確認して再試行してください。", ko: "포럼 네트워크 연결이 끊겼습니다. 네트워크를 확인한 후 다시 시도하세요.", ru: "Сетевое соединение с форумом прервано. Проверьте сеть и повторите попытку." },
    SERVER_BUSY: { "zh-CN": "论坛服务器暂时繁忙，请稍后重试", en: "The forum server is temporarily busy. Try again later.", ja: "フォーラムサーバーが一時的に混雑しています。後でもう一度お試しください。", ko: "포럼 서버가 일시적으로 바쁩니다. 잠시 후 다시 시도하세요.", ru: "Сервер форума временно занят. Повторите попытку позже." },
    NON_JSON_RESPONSE: { "zh-CN": "论坛返回的数据格式异常，请刷新论坛页面后重试", en: "The forum returned an unexpected data format. Refresh the forum page and try again.", ja: "フォーラムから予期しない形式のデータが返されました。フォーラムページを更新して再試行してください。", ko: "포럼에서 예상하지 못한 형식의 데이터가 반환되었습니다. 포럼 페이지를 새로 고친 후 다시 시도하세요.", ru: "Форум вернул данные в неожиданном формате. Обновите страницу форума и повторите попытку." },
    PAGE_CONNECTION_FAILED: { "zh-CN": "无法连接论坛页面，请先打开论坛并登录，再刷新论坛页面后重试", en: "The forum page could not be reached. Open and log in to the forum, refresh it, and try again.", ja: "フォーラムページに接続できません。フォーラムを開いてログインし、ページを更新して再試行してください。", ko: "포럼 페이지에 연결할 수 없습니다. 포럼을 열고 로그인한 뒤 페이지를 새로 고쳐 다시 시도하세요.", ru: "Не удалось подключиться к странице форума. Откройте форум, войдите в систему, обновите страницу и повторите попытку." },
    EXTENSION_RELOADED: { "zh-CN": "插件已更新或重新加载，请刷新论坛页面并重新打开插件", en: "The extension was updated or reloaded. Refresh the forum page and reopen the extension.", ja: "拡張機能が更新または再読み込みされました。フォーラムページを更新して拡張機能を再度開いてください。", ko: "확장 프로그램이 업데이트되었거나 다시 로드되었습니다. 포럼 페이지를 새로 고치고 확장 프로그램을 다시 여세요.", ru: "Расширение обновлено или перезагружено. Обновите страницу форума и снова откройте расширение." },
    PERMISSION_DENIED: { "zh-CN": "当前无法访问此内容，请确认已登录且账号有访问权限", en: "This content cannot be accessed. Make sure you are logged in and have permission.", ja: "このコンテンツにはアクセスできません。ログイン状態と権限を確認してください。", ko: "현재 이 콘텐츠에 접근할 수 없습니다. 로그인 상태와 권한을 확인하세요.", ru: "Не удалось получить доступ к содержимому. Проверьте вход и права доступа." },
    STORAGE_FULL: { "zh-CN": "浏览器本地存储空间不足，请在“更多设置”中检查插件资源", en: "The browser's local storage is full. Check extension resources in More settings.", ja: "ブラウザーのローカルストレージが不足しています。「その他の設定」で拡張機能のリソースを確認してください。", ko: "브라우저 로컬 저장 공간이 부족합니다. ‘추가 설정’에서 확장 프로그램 리소스를 확인하세요.", ru: "Недостаточно локального хранилища браузера. Проверьте ресурсы расширения в дополнительных настройках." },
    STORAGE_ERROR: { "zh-CN": "无法读写本地数据，请关闭旧版插件标签页后重新打开", en: "Local data could not be read or written. Close old extension tabs and reopen the extension.", ja: "ローカルデータを読み書きできません。古い拡張機能のタブを閉じて、拡張機能を再度開いてください。", ko: "로컬 데이터를 읽거나 쓸 수 없습니다. 이전 확장 프로그램 탭을 닫고 다시 여세요.", ru: "Не удалось прочитать или записать локальные данные. Закройте старые вкладки расширения и откройте его снова." }
  });
  let currentLanguage = "zh-CN";

  function setLanguage(language) {
    currentLanguage = SUPPORTED_LANGUAGES.some((item) => item.id === language) ? language : "zh-CN";
    return currentLanguage;
  }

  function localizedError(code, fallback = "操作未完成，请刷新页面后重试") {
    const messages = ERROR_MESSAGES[code];
    if (!messages) return fallback;
    if (currentLanguage === "zh-en") return `${messages["zh-CN"]} / ${messages.en}`;
    return messages[currentLanguage] || messages.en || messages["zh-CN"];
  }

  function localize(messages, fallback = "操作未完成，请刷新页面后重试") {
    if (!messages || typeof messages !== "object") return fallback;
    const chinese = messages["zh-CN"] || fallback;
    if (currentLanguage === "zh-en") return `${chinese} / ${messages.en || chinese}`;
    return messages[currentLanguage] || messages.en || chinese;
  }

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
    if (code) return localizedError(code, fallback);
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
      message: localizedError(code),
      contentType: response?.headers?.get?.("content-type") || "",
      preview
    };
  }

  globalThis.ByrForumClient = Object.freeze({ ForumRequestError, errorFromResponse, isThreadUnavailable, nonJsonData, retryAfterMs, isRetryable, createRequestPolicy, userMessage, localize, setLanguage, getLanguage: () => currentLanguage, supportedLanguages: () => SUPPORTED_LANGUAGES.map((item) => ({ ...item })) });
})();
