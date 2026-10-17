/* 邮人全搜界面语言：保留中文默认值，为核心静态文本提供可切换的多语言显示。 */

(function installByrUiI18n() {
  if (globalThis.ByrUiI18n) return;

  const CATALOG = Object.freeze({
    "邮人全搜": { en: "BYR Local Search", ja: "郵人全搜", ko: "우인 전체 검색", ru: "Поиск BYR" },
    "非官方": { en: "Unofficial", ja: "非公式", ko: "비공식", ru: "Неофициально" },
    "北邮人论坛搜索助手": { en: "BUPT Forum Search Assistant", ja: "北郵人フォーラム検索アシスタント", ko: "BUPT 포럼 검색 도우미", ru: "Помощник поиска на форуме BUPT" },
    "打开论坛": { en: "Open forum", ja: "フォーラムを開く", ko: "포럼 열기", ru: "Открыть форум" },
    "AI 协助": { en: "AI assistance", ja: "AI アシスト", ko: "AI 지원", ru: "Помощь ИИ" },
    "关闭": { en: "Close", ja: "閉じる", ko: "닫기", ru: "Закрыть" },
    "让支持终端的 AI 帮你操作扩展": { en: "Let a terminal-enabled AI operate the extension", ja: "ターミナル対応 AI に拡張機能を操作させる", ko: "터미널을 지원하는 AI가 확장 프로그램을 조작합니다", ru: "Позвольте ИИ с доступом к терминалу управлять расширением" },
    "你只需要把提示词交给 Codex、Claude Code、Trae 或 WorkBuddy。AI 会自动连接浏览器、启动搜索并返回结果。": { en: "Give the prompt to Codex, Claude Code, Trae, or WorkBuddy. The AI connects to the browser, starts the search, and returns results.", ja: "プロンプトを Codex、Claude Code、Trae、WorkBuddy に渡すだけで、AI がブラウザーに接続して検索し、結果を返します。", ko: "프롬프트를 Codex, Claude Code, Trae 또는 WorkBuddy에 전달하면 AI가 브라우저에 연결하고 검색을 시작해 결과를 반환합니다.", ru: "Передайте подсказку Codex, Claude Code, Trae или WorkBuddy. ИИ подключится к браузеру, выполнит поиск и вернёт результаты." },
    "先确保已经登录北邮人论坛。": { en: "First, make sure you are logged in to the BUPT forum.", ja: "まず北郵人フォーラムにログインしていることを確認してください。", ko: "먼저 BUPT 포럼에 로그인했는지 확인하세요.", ru: "Сначала убедитесь, что вы вошли на форум BUPT." },
    "点击下面的“复制给 AI”，粘贴到你的本地 AI 对话中。": { en: "Click “Copy for AI” below and paste it into your local AI chat.", ja: "下の「AI にコピー」をクリックし、ローカル AI のチャットに貼り付けてください。", ko: "아래의 ‘AI에 복사’를 클릭해 로컬 AI 대화에 붙여넣으세요.", ru: "Нажмите «Скопировать для ИИ» ниже и вставьте текст в локальный чат с ИИ." },
    "之后直接对 AI 说出搜索需求，不需要再填写端口或令牌。": { en: "Then tell the AI what to search; you do not need to enter a port or token.", ja: "あとは AI に検索内容を伝えるだけで、ポートやトークンの入力は不要です。", ko: "그 다음 AI에게 검색할 내용을 말하면 되며 포트나 토큰을 입력할 필요가 없습니다.", ru: "Затем просто сообщите ИИ, что искать; порт и токен вводить не нужно." },
    "AI 将自动执行": { en: "AI will run", ja: "AI が実行", ko: "AI가 실행", ru: "ИИ выполнит" },
    "当前连接": { en: "Connection", ja: "接続", ko: "연결", ru: "Подключение" },
    "默认搜索方式": { en: "Default search mode", ja: "既定の検索方式", ko: "기본 검색 방식", ru: "Режим поиска по умолчанию" },
    "先查本地索引；索引不足时，AI 再决定是否在线搜索。在线读取到的内容会自动写入本地索引。": { en: "Search the local index first; AI decides whether to search online when it is insufficient. Online content is saved to the local index automatically.", ja: "まずローカル索引を検索し、不足時に AI がオンライン検索を判断します。オンラインで読んだ内容は自動的にローカル索引へ保存されます。", ko: "먼저 로컬 색인을 검색하고, 부족할 때 AI가 온라인 검색 여부를 결정합니다. 온라인에서 읽은 내용은 로컬 색인에 자동 저장됩니다.", ru: "Сначала ищется локальный индекс; при нехватке данных ИИ решает, нужен ли онлайн-поиск. Прочитанные онлайн данные автоматически сохраняются в локальный индекс." },
    "检查连接": { en: "Check connection", ja: "接続を確認", ko: "연결 확인", ru: "Проверить подключение" },
    "AI 没有自动连接时怎么办？": { en: "If AI does not connect automatically", ja: "AI が自動接続しない場合", ko: "AI가 자동으로 연결되지 않으면", ru: "Если ИИ не подключается автоматически" },
    "复制给 AI": { en: "Copy for AI", ja: "AI にコピー", ko: "AI에 복사", ru: "Скопировать для ИИ" },
    "我知道了": { en: "Got it", ja: "了解", ko: "확인", ru: "Понятно" },
    "连接器只监听本机，扩展不保存论坛密码或 Cookie。AI 搜索仍会遵守当前版面和读取范围。": { en: "The connector listens only on this computer. The extension does not store forum passwords or cookies. AI searches still follow the current boards and reading range.", ja: "接続器はこのコンピューターだけで待ち受けます。拡張機能はフォーラムのパスワードや Cookie を保存しません。AI 検索も現在の版面と読み取り範囲に従います。", ko: "커넥터는 이 컴퓨터에서만 수신합니다. 확장 프로그램은 포럼 비밀번호나 쿠키를 저장하지 않습니다. AI 검색도 현재 게시판과 읽기 범위를 따릅니다.", ru: "Соединитель прослушивает только этот компьютер. Расширение не сохраняет пароли форума или cookie. Поиск ИИ также использует выбранные разделы и диапазон чтения." },
    "更多设置": { en: "More settings", ja: "その他の設定", ko: "추가 설정", ru: "Дополнительные настройки" },
    "打开此窗口时只能操作窗口内的功能，搜索会继续运行。": { en: "While this window is open, only its controls are active; searches continue running.", ja: "このウィンドウを開いている間はウィンドウ内だけ操作でき、検索は続行されます。", ko: "이 창이 열려 있는 동안에는 창 안의 기능만 조작할 수 있으며 검색은 계속됩니다.", ru: "Пока это окно открыто, доступны только его элементы управления; поиск продолжится." },
    "提示语言 / Message language": { en: "Message language", ja: "メッセージ言語", ko: "메시지 언어", ru: "Язык сообщений" },
    "错误与诊断语言": { en: "Error and diagnostic language", ja: "エラーと診断の言語", ko: "오류 및 진단 언어", ru: "Язык ошибок и диагностики" },
    "语言设置作用于论坛请求、连接诊断、Agent 提示和核心界面文字。": { en: "This setting applies to forum errors, connection diagnostics, Agent messages, and core interface text.", ja: "この設定はフォーラムエラー、接続診断、Agent メッセージ、主要な画面テキストに適用されます。", ko: "이 설정은 포럼 오류, 연결 진단, Agent 메시지 및 핵심 화면 텍스트에 적용됩니다.", ru: "Эта настройка применяется к ошибкам форума, диагностике подключения, сообщениям Agent и основным текстам интерфейса." },
    "本地索引与隐私": { en: "Local index and privacy", ja: "ローカル索引とプライバシー", ko: "로컬 색인 및 개인정보", ru: "Локальный индекс и конфиденциальность" },
    "清空本地索引": { en: "Clear local index", ja: "ローカル索引を消去", ko: "로컬 색인 지우기", ru: "Очистить локальный индекс" },
    "插件资源": { en: "Extension resources", ja: "拡張機能のリソース", ko: "확장 프로그램 리소스", ru: "Ресурсы расширения" },
    "刷新": { en: "Refresh", ja: "更新", ko: "새로 고침", ru: "Обновить" },
    "搜索版面": { en: "Search boards", ja: "版面を検索", ko: "게시판 검색", ru: "Поиск разделов" },
    "选择版面": { en: "Select boards", ja: "版面を選択", ko: "게시판 선택", ru: "Выбрать разделы" },
    "检查已选": { en: "Review selected", ja: "選択内容を確認", ko: "선택 항목 확인", ru: "Проверить выбранные" },
    "分区": { en: "Section", ja: "セクション", ko: "구역", ru: "Раздел" },
    "目录": { en: "Directory", ja: "ディレクトリ", ko: "목록", ru: "Каталог" },
    "具体版面": { en: "Board", ja: "版面", ko: "게시판", ru: "Подраздел" },
    "全部版面": { en: "All boards", ja: "すべての版面", ko: "모든 게시판", ru: "Все разделы" },
    "清空选择": { en: "Clear selection", ja: "選択を解除", ko: "선택 지우기", ru: "Очистить выбор" },
    "从论坛读取/刷新版面": { en: "Load/refresh boards from forum", ja: "フォーラムから版面を読み込む/更新", ko: "포럼에서 게시판 읽기/새로 고침", ru: "Загрузить/обновить разделы форума" },
    "读取范围": { en: "Reading range", ja: "読み取り範囲", ko: "읽기 범위", ru: "Диапазон чтения" },
    "每版主题页数": { en: "Topic pages per board", ja: "版面ごとのトピックページ数", ko: "게시판별 주제 페이지 수", ru: "Страниц тем на раздел" },
    "每帖内容页数": { en: "Content pages per topic", ja: "トピックごとの内容ページ数", ko: "주제별 내용 페이지 수", ru: "Страниц содержимого на тему" },
    "全部": { en: "All", ja: "すべて", ko: "전체", ru: "Все" },
    "日期范围": { en: "Date range", ja: "日付範囲", ko: "날짜 범위", ru: "Диапазон дат" },
    "不限时间": { en: "Any time", ja: "期間指定なし", ko: "기간 제한 없음", ru: "Любой период" },
    "最近 30 天": { en: "Last 30 days", ja: "過去30日", ko: "최근 30일", ru: "Последние 30 дней" },
    "自定义日期": { en: "Custom dates", ja: "日付を指定", ko: "사용자 지정 날짜", ru: "Свои даты" },
    "开始日期": { en: "Start date", ja: "開始日", ko: "시작 날짜", ru: "Дата начала" },
    "结束日期": { en: "End date", ja: "終了日", ko: "종료 날짜", ru: "Дата окончания" },
    "常用范围": { en: "Saved scopes", ja: "保存済み範囲", ko: "저장된 범위", ru: "Сохранённые диапазоны" },
    "保存范围": { en: "Save scope", ja: "範囲を保存", ko: "범위 저장", ru: "Сохранить диапазон" },
    "删除": { en: "Delete", ja: "削除", ko: "삭제", ru: "Удалить" },
    "＋ 保存新组合": { en: "+ Save new scope", ja: "＋ 新しい範囲を保存", ko: "＋ 새 범위 저장", ru: "＋ Сохранить новый диапазон" },
    "本地索引管理": { en: "Local index", ja: "ローカル索引管理", ko: "로컬 색인 관리", ru: "Локальный индекс" },
    "增量更新": { en: "Incremental update", ja: "差分更新", ko: "증분 업데이트", ru: "Инкрементальное обновление" },
    "完整重新检查": { en: "Full recheck", ja: "完全再確認", ko: "전체 다시 확인", ru: "Полная проверка" },
    "开始更新索引": { en: "Update local index", ja: "ローカル索引を更新", ko: "로컬 색인 업데이트", ru: "Обновить локальный индекс" },
    "暂停": { en: "Pause", ja: "一時停止", ko: "일시 중지", ru: "Пауза" },
    "搜索结果管理": { en: "Search result management", ja: "検索結果の管理", ko: "검색 결과 관리", ru: "Управление результатами" },
    "已保存会话": { en: "Saved sessions", ja: "保存済みセッション", ko: "저장된 세션", ru: "Сохранённые сеансы" },
    "重新获取最新数据": { en: "Fetch latest data", ja: "最新データを再取得", ko: "최신 데이터 다시 가져오기", ru: "Получить свежие данные" },
    "保存结果": { en: "Save results", ja: "結果を保存", ko: "결과 저장", ru: "Сохранить результаты" },
    "保存会话": { en: "Save session", ja: "セッションを保存", ko: "세션 저장", ru: "Сохранить сеанс" },
    "请求速度": { en: "Request speed", ja: "リクエスト速度", ko: "요청 속도", ru: "Скорость запросов" },
    "选择请求速度": { en: "Request speed", ja: "リクエスト速度を選択", ko: "요청 속도 선택", ru: "Выберите скорость запросов" },
    "在线搜索": { en: "Online search", ja: "オンライン検索", ko: "온라인 검색", ru: "Онлайн-поиск" },
    "本地搜索": { en: "Local search", ja: "ローカル検索", ko: "로컬 검색", ru: "Локальный поиск" },
    "搜索": { en: "Search", ja: "検索", ko: "검색", ru: "Поиск" },
    "综合": { en: "All", ja: "すべて", ko: "전체", ru: "Все" },
    "帖子": { en: "Topics", ja: "トピック", ko: "주제", ru: "Темы" },
    "回帖": { en: "Replies", ja: "返信", ko: "답글", ru: "Ответы" },
    "用户": { en: "Users", ja: "ユーザー", ko: "사용자", ru: "Пользователи" },
    "版面": { en: "Boards", ja: "版面", ko: "게시판", ru: "Разделы" },
    "按相关度": { en: "By relevance", ja: "関連度順", ko: "관련도순", ru: "По релевантности" },
    "按时间": { en: "By time", ja: "時間順", ko: "시간순", ru: "По времени" },
    "上一页": { en: "Previous", ja: "前へ", ko: "이전", ru: "Назад" },
    "下一页": { en: "Next", ja: "次へ", ko: "다음", ru: "Далее" }
  });

  const textNodes = new WeakMap();
  const attributes = new WeakMap();

  function languageCode(language) {
    if (language === "zh-en") return "zh-en";
    return ["en", "ja", "ko", "ru"].includes(language) ? language : "zh-CN";
  }

  function translate(key, language = "zh-CN") {
    const entry = CATALOG[key];
    if (!entry) return key;
    const code = languageCode(language);
    if (code === "zh-CN") return key;
    if (code === "zh-en") return `${key} / ${entry.en || key}`;
    return entry[code] || entry.en || key;
  }

  function apply(root = document, language = "zh-CN") {
    if (!root?.createTreeWalker) return;
    const walker = root.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
      const raw = node.nodeValue || "";
      const trimmed = raw.trim();
      const key = textNodes.get(node) || (Object.prototype.hasOwnProperty.call(CATALOG, trimmed) ? trimmed : "");
      if (!key) continue;
      textNodes.set(node, key);
      const start = raw.indexOf(trimmed);
      node.nodeValue = `${raw.slice(0, start)}${translate(key, language)}${raw.slice(start + trimmed.length)}`;
    }
    root.querySelectorAll?.("[placeholder], [title], [aria-label]").forEach((element) => {
      ["placeholder", "title", "aria-label"].forEach((attribute) => {
        const value = element.getAttribute(attribute);
        if (!value) return;
        const key = attributes.get(element)?.[attribute] || (Object.prototype.hasOwnProperty.call(CATALOG, value) ? value : "");
        if (!key) return;
        const mapped = attributes.get(element) || {};
        mapped[attribute] = key;
        attributes.set(element, mapped);
        element.setAttribute(attribute, translate(key, language));
      });
    });
    if (root.documentElement) root.documentElement.lang = language === "en" ? "en" : language === "ja" ? "ja" : language === "ko" ? "ko" : language === "ru" ? "ru" : "zh-CN";
    if (root.title) root.title = translate("邮人全搜", language);
  }

  globalThis.ByrUiI18n = Object.freeze({ apply, translate, catalog: () => ({ ...CATALOG }) });
})();
