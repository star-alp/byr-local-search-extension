/* 独立 Chrome 集成测试：使用模拟论坛和真实 IndexedDB 验证迁移、暂停恢复、重试和历史保护。 */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const scenario = String.raw`
(async () => {
  document.documentElement.dataset.smoke = 'starting';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const resume = JSON.parse(sessionStorage.getItem('byr-smoke-resume') || 'null');
  const counts = resume?.counts || {};
  let fail = resume ? resume.fail : true;
  let shouldPause = !resume;
  let modalOpenedDuringSearch = false;
  let failNativeThirdPage = true;
  let cacheContent = '可复用资料';
  let omitThread9 = false;
  window.confirm = () => true;
  globalThis.chrome = { runtime: { async sendMessage(message) {
    const url = new URL(message.path, 'https://bbs.byr.cn');
    const pathname = url.pathname;
    counts[message.path] = (counts[message.path] || 0) + 1;
    await new Promise(resolve => setTimeout(resolve, 8));
    if (pathname === '/n/b/section.json') return { ok: true, sourceTabId: 1, data: { success: true, data: {
      boards: [{ dir: true, name: '测试分区', children: [{ dir: false, name: '谈天说地', desc: 'Talking' }, { dir: false, name: '学习交流', desc: 'StudyShare' }] }]
    } } };
    if (pathname === '/s/article' && !resume && !modalOpenedDuringSearch) {
      document.querySelector('#open-settings').click();
      modalOpenedDuringSearch = true;
      assert(document.querySelector('#search-settings').matches(':modal'), '搜索期间应能打开模态设置窗口');
      assert(state.onlineSearchRunning && document.querySelector('#clear-index').disabled, '弹窗不能暂停搜索，搜索期间不能清空索引');
    }
    if (pathname === '/s/article' && decodeURIComponent(url.searchParams.get('t1') || '') === '陶小峰') {
      const page = Number(url.searchParams.get('p')) || 1;
      if (page === 3 && failNativeThirdPage) { failNativeThirdPage = false; return { ok: false, error: '模拟原生第三页网络错误' }; }
      const gid = 69 + page;
      const next = new URL(url);
      next.searchParams.set('p', String(page + 1));
      return { ok: true, status: 200, text:
        '<table class="board-list"><tr><td>1</td><td><a href="/article/Talking/' + gid + '">陶小峰历史主题' + gid + '</a><span class="threads-tab"><a href="/article/Talking/' + gid + '?p=9">9</a></span></td><td>2026-10-' + (page === 1 ? '10' : '12') + '</td><td><a>teacher</a></td><td>3</td></tr></table>'
        + (page < 3 ? '<ul class="pagination"><li><ol class="page-main"><li class="page-normal"><a href="' + (next.pathname + next.search).replaceAll('&', '&amp;') + '" title="下一页">&gt;&gt;</a></li></ol></li></ul>' : '')
      };
    }
    if (pathname === '/s/article') return { ok: true, status: 200, text:
      '<table class="board-list"><tr><td>1</td><td><a href="/article/Talking/7">txf 旧主题</a></td><td>2026-10-12</td><td><a>txf</a></td><td>3</td></tr></table>'
    };
    if (pathname === '/n/b/board/Talking.json') return { ok: true, data: { success: true, data: {
      pagination: { total: 1 }, posts: (omitThread9 ? [7, 8] : [7, 8, 9]).map(gid => ({ gid: String(gid), title: 'txf 主题', poster: 'txf' }))
    } } };
    const gid = pathname.match(/\/(\d+)\.json$/)?.[1];
    if (['70', '71', '72'].includes(gid)) return { ok: true, data: { success: true, data: {
      pagination: { total: 1 }, title: '陶小峰历史主题' + gid,
      head: { id: 'history-head-' + gid, poster: { id: 'teacher' }, content: '课程资料', time: gid === '70' ? 1791561600 : '2026-10-12' },
      articles: [
        { id: 'history-reply-' + gid + '-1', pos: 1, poster: { id: 'student' }, content: '陶小峰课程的回帖', time: '2026-10-12' },
        { id: 'history-reply-' + gid + '-2', pos: 2, poster: { id: 'student' }, content: '谢谢分享', time: '2026-10-12' },
        { id: 'history-reply-' + gid + '-3', pos: 3, poster: { id: 'studentWithName', user_name: '陶小峰' }, content: '补充资料', time: '2026-10-12' }
      ]
    } } };
    if (gid === '8' && fail) { fail = false; return { ok: false, error: '模拟单帖网络错误' }; }
    if (shouldPause && gid === '7') { shouldPause = false; queueMicrotask(() => pauseTask('online')); }
    return { ok: true, data: { success: true, data: {
      pagination: { total: 2 }, title: 'txf 主题',
      head: { id: 'head-' + gid, poster: { id: 'txf' }, content: 'txf 完整正文 ' + gid + ' ' + cacheContent, time: 1791750000 },
      articles: [{ id: 'reply-' + gid + '-' + url.searchParams.get('page'), pos: Number(url.searchParams.get('page')), poster: { id: 'txf' }, content: 'txf 回帖', time: 1791750000 }]
    } } };
  } } };

  if (!resume) {
  const seed = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('documents', { keyPath: 'id' });
      request.result.createObjectStore('boards', { keyPath: 'name' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = seed.transaction(['documents', 'boards'], 'readwrite');
    transaction.objectStore('documents').put({ id: 'thread:Talking:7', type: 'thread', board: 'Talking', gid: '7', title: '旧标题', content: '历史完整正文', authorName: '旧昵称' });
    transaction.objectStore('documents').put({ id: 'thread:Talking:99', type: 'thread', board: 'Talking', gid: '99', title: '历史帖子', content: '保留历史' });
    transaction.objectStore('boards').put({ name: 'Talking', description: '谈天说地' });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  seed.close();
  localStorage.setItem(SCOPE_PRESETS_STORAGE_KEY, JSON.stringify({ presets: [], activeId: 'recommended' }));
  }
  document.documentElement.dataset.smoke = 'initializing';
  await init();
  assert(state.sessionPages.size === 0 && state.sessionCacheBytes === 0, '页面重新打开不能从持久存储恢复正文会话缓存');
  assert(state.searchMode === 'online', '默认应为在线');
  assert(document.querySelector('#search-settings').hidden, '首页设置应折叠');
  if (!resume) {
    assert(document.querySelector('#manual-board-details').open, '没有保存范围的新用户应默认展开手动选择');
    assert(!document.querySelector('#scope-presets-details').open, '常用范围应默认折叠，避免干扰手动选择');
    assert(state.activeScopeId === 'current', '旧版自动推断的推荐标签不能作为明确选用模板的记录');
    setBoardSelection(defaultBoardNames());
    assert(state.activeScopeId === 'current' && document.querySelector('#scope-presets-summary').textContent.includes('手动选择'), '手动配置与推荐完全一致也不能自动切换为模板');
    setBoardSelection(['Talking']);
  } else assert(!document.querySelector('#manual-board-details').open, '重新打开已应用预设时应收起手动选择');
  document.querySelector('#index-board-pages').value = '1';
  document.querySelector('#index-thread-pages').value = '2';
  updateIndexRangeSummary();
  state.requestDelayMs = 0;
  state.requestConcurrency = 2;
  document.querySelector('#query-input').value = 'txf';
  document.documentElement.dataset.smoke = 'searching';
  if (!resume) {
    const openManager = () => {
      if (!document.querySelector('#scope-presets-details').open) document.querySelector('#scope-presets-details > summary').click();
      assert(document.querySelector('#scope-presets-details').open && !document.querySelector('#search-settings').open, '管理范围应在侧栏展开，不能打开弹窗');
    };
    openManager();
    assert(document.querySelector('#manual-board-details').closest('#settings-preferences-panel') && document.querySelector('#scope-presets-details').closest('#settings-preferences-panel') && document.querySelector('#index-board-pages').closest('#settings-preferences-panel'), '手动选择、常用范围与读取范围都应位于左侧侧栏');
    assert(!document.querySelector('#scope-preset-select') && !document.querySelector('#toggle-settings'), '应删除重复的范围切换与管理入口');
    document.querySelector('#scope-preset-name').value = '谈天速查';
    document.querySelector('#save-scope-preset').click();
    assert(state.scopePresets.length === 1, '应能保存第一个范围');
    const firstId = state.scopePresets[0].id;
    assert(state.activeScopeId === firstId, '保存后侧栏应显示范围名称');
    assert(!document.querySelector('#manual-board-details').open && document.querySelector('#scope-presets-summary').textContent.includes('谈天速查'), '保存后应显示当前常用范围并收起手动选择');
    const originalOptions = localStorage.getItem(INDEX_OPTIONS_STORAGE_KEY);
    const originalBoards = localStorage.getItem(BOARD_SELECTION_STORAGE_KEY);
    openManager();
    document.querySelector('#new-scope-preset').click();
    assert(document.querySelector('#manual-board-details').open, '创建新组合时应能继续手动选择版面');
    setBoardSelection(['Talking', 'StudyShare']);
    document.querySelector('#index-board-pages').value = '4';
    document.querySelector('#index-thread-pages').value = '5';
    document.querySelector('#index-time-range').value = '30d';
    updateIndexRangeSummary();
    document.querySelector('#scope-preset-name').value = '升学近况';
    document.querySelector('#save-scope-preset').click();
    assert(state.scopePresets.length === 2 && state.scopePresets[1].boards.length === 2, '应能保存多版面范围');
    const secondId = state.scopePresets[1].id;
    assert(state.scopePresets[0].options.boardPages === 1 && state.scopePresets[0].boards.length === 1, '创建第二个组合不能覆盖第一个范围');
    const switchScope = (id) => {
      openManager();
      const button = [...document.querySelectorAll('#scope-preset-list button')].find(item => item.dataset.scopeId === id);
      assert(button, '应能在常用范围列表找到对应按钮');
      button.click();
      assert(!document.querySelector('#manual-board-details').open, '选择预设后应收起三栏选择，可以直接搜索');
    };
    switchScope(firstId);
    assert(localStorage.getItem(INDEX_OPTIONS_STORAGE_KEY) === originalOptions && localStorage.getItem(BOARD_SELECTION_STORAGE_KEY) === originalBoards, '切回第一个范围应恢复其配置');
    switchScope(secondId);
    assert(state.selectedBoardNames.size === 2 && readIndexOptions().boardPageLimit === 4 && readIndexOptions().threadPageLimit === 5, '首页切换应应用版面与页数');
    const thirtyDays = 30 * 86400000;
    assert(Math.abs(readIndexOptions().timeRange.start - (Date.now() - thirtyDays)) < 1000, '最近30天应在使用时计算');
    openManager();
    document.querySelector('#scope-preset-name').value = '学习与升学';
    document.querySelector('#index-time-range').value = 'custom';
    document.querySelector('#index-date-from').value = '2026-10-01';
    document.querySelector('#index-date-to').value = '2026-10-12';
    updateIndexRangeSummary();
    document.querySelector('#save-scope-preset').click();
    assert(state.scopePresets.length === 2 && state.scopePresets[1].id === secondId, '重命名和更新应保留范围身份');
    switchScope('recommended');
    assert(readIndexOptions().boardPageLimit === 3 && readIndexOptions().timeRange === null, '推荐范围应保持内置默认配置');
    assert(document.querySelector('#scope-presets-summary').textContent.includes('正在使用：推荐版面'), '主动点击推荐模板后才应显示正在使用推荐');
    toggleBoardSelection('StudyShare');
    toggleBoardSelection('StudyShare');
    assert(state.activeScopeId === 'current', '手动修改再改回模板配置仍应保持手动选择');
    switchScope(secondId);
    assert(document.querySelector('#index-date-from').value === '2026-10-01' && readIndexOptions().timeRange.end > readIndexOptions().timeRange.start, '切换应还原自定义日期');
    document.querySelector('#manual-board-details > summary').click();
    assert(document.querySelector('#manual-board-details').open, '预设使用者应能重新展开手动选择');
    setBoardSelection(['Talking']);
    assert(state.activeScopeId === 'current' && !document.querySelector('#scope-preset-list .is-active'), '临时改动后不能继续高亮旧预设');
    assert(state.scopePresets[1].boards.length === 2, '临时改动不能覆盖保存的版面组合');
    switchScope(secondId);
    openManager();
    document.querySelector('#new-scope-preset').click();
    document.querySelector('#scope-preset-name').value = '谈天速查';
    document.querySelector('#save-scope-preset').click();
    assert(state.scopePresets.length === 2 && document.querySelector('#scope-preset-feedback').textContent.includes('同名'), '重名范围应提示且不覆盖已有范围');
    document.querySelector('#scope-preset-name').value = '临时范围';
    document.querySelector('#index-board-pages').value = '';
    document.querySelector('#index-board-all').checked = true;
    document.querySelector('#index-board-all').dispatchEvent(new Event('change'));
    document.querySelector('#save-scope-preset').click();
    assert(state.scopePresets.length === 3, '应能继续创建范围');
    loadScopePresets();
    assert(state.scopePresets.length === 3 && state.scopePresets[2].options.boardAll, '全部页数范围不能因为停用输入框为空而在恢复时丢失');
    document.querySelector('#delete-scope-preset').click();
    assert(state.scopePresets.length === 2 && state.documents.length === 2, '删除范围不能删除索引内容');
    assert(!document.querySelector('.sidebar-heading'), '没有功能的搜索设置标题应移除');
    assert(document.querySelector('#clear-index').closest('#search-settings') && document.querySelector('#refresh-resources').closest('#search-settings'), '隐私与资源应迁入弹窗');
    document.querySelector('#open-settings').click();
    assert(document.querySelector('#search-settings').matches(':modal'), '更多设置入口应打开模态弹窗');
    document.querySelector('#search-settings').dispatchEvent(new Event('cancel', { cancelable: true }));
    assert(document.querySelector('#search-settings').hidden, 'Escape取消事件应关闭弹窗');
    switchScope(firstId);
    const sidebar = document.querySelector('#settings-preferences-panel');
    assert(!sidebar.hidden && !sidebar.closest('dialog'), '搜索范围、索引更新和性能应常驻侧边栏');
    assert(!document.querySelector('#start-index').closest('dialog') && !document.querySelector('#request-concurrency').closest('dialog'), '其他设置不能进入范围弹窗');
    await startOnlineSearch();
    assert(modalOpenedDuringSearch && document.querySelector('#search-settings').open && state.onlineDocuments.some(doc => doc.contentFetched), '弹窗打开期间应继续获取数据并补全正文结果');
    document.querySelector('#close-settings').click();
    assert(!document.querySelector('#search-settings').open, '关闭按钮应解除模态状态');
    assert(state.tasks.online.phase === 'paused', '应在正文请求后暂停');
    assert(state.onlineDocuments.length > 0, '暂停前应已显示增量结果');
    const checkpoint = (await getAll('tasks')).find(task => task.mode === 'online');
    assert(checkpoint.phase === 'paused', '进度应持久化');
    sessionStorage.setItem('byr-smoke-resume', JSON.stringify({ counts, fail }));
    location.reload();
    return;
  }
  assert(state.scopePresets.length === 2 && state.scopePresets[1].name === '学习与升学', '重新打开后应恢复多个范围和名称');
  assert(state.activeScopeId === state.scopePresets[0].id && readIndexOptions().boardPageLimit === 1, '重新打开后应恢复上次应用的范围');
  assert(state.tasks.online.phase === 'paused', '应能恢复暂停任务');
  assert(state.onlineDocuments.length > 0, '恢复应保留命中');
  assert(document.querySelector('#result-list').textContent.includes('主题'), '恢复任务后结果列表应同步显示已保存的命中');
  selectScopePreset(state.scopePresets[1].id);
  assert(state.tasks.online.boards.length === 1 && state.tasks.online.options.boardPageLimit === 1, '切换范围不能改变已经暂停的任务');
  selectScopePreset(state.scopePresets[0].id);
  await continueTask('online');
  assert(state.tasks.online.phase === 'partial', '单帖失败应标注部分完成');
  assert(state.tasks.online.jobs.some(job => job.post?.gid === '9' && job.status === 'done'), '失败后应继续其他帖子');
  const countGood = () => Object.entries(counts).filter(([key]) => key.includes('/9.json')).reduce((sum, [, value]) => sum + value, 0);
  const goodBefore = countGood();
  await continueTask('online', true);
  assert(state.tasks.online.phase === 'complete', '失败项重试后应完成');
  assert(goodBefore === countGood(), '重试不应重复成功主题');
  await saveOnlineResults();
  let saved = await getAll('documents');
  assert(saved.some(doc => doc.gid === '99'), '在线保存应保留历史');
  await saveDocuments([{ id: 'thread:Talking:7', nativeSearch: true, content: '', authorName: '' }]);
  saved = await getAll('documents');
  assert(saved.find(doc => doc.id === 'thread:Talking:7').content.includes('完整正文'), '快速候选不能覆盖完整正文');
  await saveDocuments([
    { id: 'thread:StudyShare:100', type: 'thread', board: 'StudyShare', gid: '100', title: '范围独有命中', content: '范围独有命中', author: 'onlyInStudy', time: '2026-10-10' },
    { id: 'thread:StudyShare:101', type: 'thread', board: 'StudyShare', gid: '101', title: '范围独有命中', content: '范围独有命中', author: 'onlyInStudy', time: '2025-01-01' }
  ]);
  state.documents = await getAll('documents');
  setSearchMode('local');
  document.querySelector('#query-input').value = '范围独有命中';
  renderResults();
  assert(searchDocuments('范围独有命中').length === 0, '本地搜索应排除范围外版面的帖子');
  selectScopePreset(state.scopePresets[1].id);
  assert(searchDocuments('范围独有命中').length === 1 && document.querySelector('#result-list').textContent.includes('范围独有命中'), '本地切换范围应立即筛选版面和日期并刷新结果');
  assert(userResults('onlyInStudy')[0].user.count === 1, '本地用户聚合也应遵守版面和日期范围');
  selectScopePreset(state.scopePresets[0].id);
  assert(userResults('onlyInStudy').length === 0 && boardResults('StudyShare').length === 0, '本地用户与版面导航不能泄漏范围外结果');
  setSearchMode('online');
  document.querySelector('#query-input').value = 'txf';
  setBoardSelection([]);
  assert(document.querySelector('#start-index').disabled, '侧栏未选择版面时应禁用索引更新');
  selectScopePreset(state.scopePresets[0].id);
  document.querySelector('#index-board-pages').value = '6';
  updateIndexRangeSummary();
  assert(!document.querySelector('#start-index').disabled, '侧栏已选择版面时应允许更新索引');
  await startNewTask('index');
  assert(state.tasks.index.boards.length === 1 && state.tasks.index.options.boardPageLimit === 6, '侧栏修改应进入下一次任务，但不能覆盖已保存的预设');
  assert(state.scopePresets[0].options.boardPages === 1, '临时调整页数不能自动改写预设');
  selectScopePreset(state.scopePresets[0].id);
  saved = await getAll('documents');
  assert(saved.some(doc => doc.gid === '99'), '小范围索引更新不能清掉历史');
  assert(state.tasks.index.phase === 'complete', '索引应完成');
  const titleOnlyReply = { id: 'reply:Talking:500:1', type: 'reply', board: 'Talking', gid: '500', title: '陶小峰课程', content: '谢谢分享', author: 'student', pos: 1, time: '2026-10-12' };
  await saveDocuments([titleOnlyReply]);
  state.documents = await getAll('documents');
  setSearchMode('local');
  assert(!searchDocuments('陶小峰').some(item => item.documentData.id === titleOnlyReply.id), '旧本地索引中只因标题命中的回帖也应被排除');
  setSearchMode('online');
  document.querySelector('#query-input').value = '陶小峰';
  document.querySelector('#index-board-pages').value = '2';
  document.querySelector('#index-thread-pages').value = '1';
  updateIndexRangeSummary();
  state.sort = 'recent';
  document.querySelector('#sort-select').value = 'recent';
  await startOnlineSearch();
  assert(state.tasks.online.phase === 'complete', '两页原生搜索应完成');
  assert(ByrTasks.metrics(state.tasks.online).nativePages === 2, '应统计两页成功的原生搜索');
  assert(state.onlineDocuments.some(doc => doc.gid === '71' && doc.contentFetched), '原生第二页的历史主题应被找到并补全正文');
  assert(!state.tasks.online.jobs.some(job => job.kind === 'native' && job.page > 2), '原生搜索不能超过每版页数上限');
  assert(!state.onlineDocuments.some(doc => doc.type === 'reply' && doc.pos === 2), '标题命中不能导致无关回帖加入在线结果');
  assert(state.onlineDocuments.some(doc => doc.type === 'reply' && doc.pos === 1), '正文命中回帖应保留');
  assert(state.onlineDocuments.some(doc => doc.type === 'reply' && doc.pos === 3), '作者昵称命中回帖应保留');
  assert(state.onlineDocuments.some(doc => doc.type === 'reply' && doc.url.includes('byr_article_id=history-reply-')), '正文结果链接应携带可校验的回帖编号');
  assert(state.onlineDocuments.filter(doc => doc.gid === '71' && doc.type === 'thread').length === 1, '快速候选和正文应合并成一条主题结果');
  const cards = [...document.querySelectorAll('.result-card')].filter(card => card.querySelector('.result-kind').textContent === '帖子');
  assert(cards[0].textContent.includes('主题71') && cards[1].textContent.includes('主题70'), '综合结果应按真实时间将新主题排在旧主题之前');
  assert(document.querySelector('#result-list').textContent.includes('命中：回帖'), '结果应显示回帖命中字段');
  document.querySelector('#index-board-all').checked = true;
  document.querySelector('#index-board-all').dispatchEvent(new Event('change'));
  await startOnlineSearch();
  assert(state.tasks.online.phase === 'partial' && state.tasks.online.jobs.some(job => job.kind === 'native' && job.page === 3 && job.status === 'failed'), '原生后续页失败应保留已找到内容并允许重试');
  const successfulNativeRequests = () => Object.entries(counts).filter(([key]) => {
    const url = new URL(key, 'https://bbs.byr.cn');
    return url.pathname === '/s/article' && decodeURIComponent(url.searchParams.get('t1') || '') === '陶小峰' && Number(url.searchParams.get('p') || 1) < 3;
  }).reduce((sum, [, value]) => sum + value, 0);
  const successfulBeforeRetry = successfulNativeRequests();
  await continueTask('online', true);
  assert(state.tasks.online.phase === 'complete' && ByrTasks.metrics(state.tasks.online).nativePages === 3, '全部模式应读到原生末页后停止，重试后完成');
  assert(successfulBeforeRetry === successfulNativeRequests(), '重试原生失败页不能重读成功页');
  assert(state.onlineDocuments.some(doc => doc.gid === '72' && doc.contentFetched), '重试找到的新主题也应补全正文');
  document.querySelector('#query-input').value = '陶小峰 OR txf';
  document.querySelector('#index-board-all').checked = false;
  document.querySelector('#index-board-pages').value = '2';
  document.querySelector('#index-board-all').dispatchEvent(new Event('change'));
  await startOnlineSearch();
  assert(state.tasks.online.phase === 'complete', 'OR 混合查询应完成');
  assert(state.onlineDocuments.some(doc => doc.gid === '71') && state.onlineDocuments.some(doc => doc.gid === '7'), 'OR 应合并中文名和缩写的独立命中');
  assert(userResults('没有此账号 OR txf').some(result => result.user.id === 'txf'), '用户聚合也应支持 OR');
  assert(boardResults('没有此版面 OR Talking').some(result => result.documentData.board === 'Talking'), '版面导航也应支持 OR');
  assert(new Set(state.onlineDocuments.map(doc => doc.id)).size === state.onlineDocuments.length, '多组查询不能产生重复结果');
  assert(state.tasks.online.jobs.filter(job => job.kind === 'native' && job.page === 1).length === 3, 'OR 应分别调用中文标题、缩写标题和缩写作者搜索');
  assert(state.tasks.online.cachePages > 0 && document.querySelector('#online-search-status').textContent.includes('复用'), '缓存复用应标明节省的内容页');
  const contentRequestCount = () => Object.entries(counts).filter(([key]) => key.startsWith('/n/b/article/')).reduce((sum, [, value]) => sum + value, 0);
  const indexSizeBeforeCache = (await getAll('documents')).length;
  const requestsBeforeCache = contentRequestCount();
  document.querySelector('#query-input').value = '可复用资料';
  const cachedSearch = startOnlineSearch();
  assert(state.onlineDocuments.filter(doc => doc.type === 'thread').length === 3, '换词应在第一个网络请求前搜索上次未命中的已读正文');
  assert(document.querySelector('#result-list').textContent.includes('缓存预览'), '即时结果应标记缓存来源与获取时间');
  await cachedSearch;
  assert(state.tasks.online.phase === 'complete' && contentRequestCount() === requestsBeforeCache, '未过期正文应复用，但原生搜索与目录继续刷新');
  assert((await getAll('documents')).length === indexSizeBeforeCache, '会话缓存不能自动写入本地搜索索引');
  omitThread9 = true;
  const changedDirectorySearch = startOnlineSearch();
  assert(state.onlineDocuments.some(doc => doc.gid === '9' && doc.cachePreview), '目录刷新前允许显示注明来源的旧缓存预览');
  await changedDirectorySearch;
  assert(state.onlineDocuments.length === 2 && !state.onlineDocuments.some(doc => doc.gid === '9'), '扫描完成后应移除已不在本次目录范围内的缓存预览');
  omitThread9 = false;
  await startOnlineSearch();
  document.querySelector('#index-thread-pages').value = '1';
  updateIndexRangeSummary();
  document.querySelector('#query-input').value = 'txf';
  await startOnlineSearch();
  assert(!state.onlineDocuments.some(doc => doc.type === 'reply' && doc.pos > 1), '缩小每帖页数后不能混入已缓存的后续页回帖');
  document.querySelector('#index-time-range').value = 'custom';
  document.querySelector('#index-date-from').value = '2025-01-01';
  document.querySelector('#index-date-to').value = '2025-01-02';
  updateIndexRangeSummary();
  await startOnlineSearch();
  assert(!state.onlineDocuments.length, '缓存预览与复用均应遵守本次日期范围');
  document.querySelector('#index-time-range').value = 'all';
  updateIndexRangeSummary();
  setBoardSelection(['StudyShare']);
  document.querySelector('#query-input').value = '可复用资料';
  const otherBoardSearch = startOnlineSearch();
  assert(!state.onlineDocuments.length, '切换版面后不能立即混入其他版面的缓存');
  await otherBoardSearch;
  setBoardSelection(['Talking']);
  await startOnlineSearch();
  assert(state.onlineDocuments.length === 3, '切回原版面应能重新使用有效缓存');
  cacheContent = '已更新正文';
  const requestsBeforeFresh = contentRequestCount();
  document.querySelector('#fresh-online').click();
  for (let attempt = 0; attempt < 100 && state.onlineSearchRunning; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert(state.tasks.online.phase === 'complete' && !state.tasks.online.cachePages, '重新获取最新数据应绕过会话缓存');
  assert(contentRequestCount() > requestsBeforeFresh && !state.onlineDocuments.length, '强制刷新应重新请求正文并移除已不匹配的旧缓存命中');
  state.sessionPages.forEach(entry => { entry.fetchedAt = Date.now() - SESSION_CACHE_TTL_MS; });
  document.querySelector('#query-input').value = '已更新正文';
  const expiredSearch = startOnlineSearch();
  assert(!state.onlineDocuments.length, '过期缓存不能用于立即预览');
  await expiredSearch;
  assert(state.onlineDocuments.length === 3 && !state.tasks.online.cachePages, '过期正文应重新获取并匹配新内容');
  setSettingsOpen(true);
  assert(!document.querySelector('#search-settings').hidden, '设置应可展开');
  setSettingsOpen(false);
  const result = { ok: true, onlineHits: state.onlineDocuments.length, savedDocuments: saved.length, orQueries: true, cacheFindsPreviouslyUnmatched: true, cacheReducesRequests: true, cacheScopeProtected: true, cacheExpiry: true, forceRefresh: true, replyMatchesOwnFields: true, nativePagination: true, nativePageLimit: true, nativeRetryOnlyFailed: true, mixedTimeSort: true, checkpointRecovered: true, reopenedPageRecovered: true, retryWithoutRepeating: true, historyPreserved: true, privacyAndResourcesInDialog: true, searchContinuesInModal: true, explicitPresetSelection: true, rangeInSidebar: true, manualFirst: true, presetSkipsManualPicker: true, scopePresets: state.scopePresets.length, presetsRemainIndependent: true, taskScopeProtected: true, scopeFiltersLocal: true };
  document.body.insertAdjacentHTML('beforeend', '<pre id="integration-result">' + JSON.stringify(result) + '</pre>');
  document.documentElement.dataset.smoke = 'finished';
})().catch(error => document.body.insertAdjacentHTML('beforeend', '<pre id="integration-result">' + JSON.stringify({ ok: false, error: error.message, stack: error.stack }) + '</pre>'));
`;

const html = read("search.html").replace("</body>", "<script>" + scenario + "</script></body>");
const server = http.createServer((req, res) => {
  if (req.url === "/search.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(read("search.js").replace(/init\(\)\.catch\([\s\S]*$/, ""));
  } else if (req.url === "/task-engine.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(read("task-engine.js"));
  } else if (req.url === "/search.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(read("search.css"));
  } else if (req.url === "/content.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(read("content.js"));
  } else if (req.url === "/jump") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><title>论坛跳转高亮测试</title>
      <div class="article" id="banner">资料：论坛横幅</div><div id="posts"></div>
      <script>globalThis.chrome={runtime:{onMessage:{addListener(){}},sendMessage(){}}};
      globalThis.byrSearchJumpTimeoutMs=500;
      globalThis.renderPosts=()=>{document.getElementById('posts').innerHTML=
      '<a name="a0"></a><div class="a-wrap" id="post0"><table class="article"><tr><td class="a-u-name">TeAcHer</td><td><div class="a-content-wrap">楼主资料 <b>资</b>料 <a id="original-link" href="#">资料链接</a> C++ <span hidden>资料</span><button>资料</button><textarea>资料</textarea><a class="a-post" href="/article/StudyShare/post/700">回复</a></div></td></tr></table></div>'+
      '<a name="a4"></a><div class="a-wrap" id="post4"><table class="article"><tr><td class="a-content-wrap">第4楼回帖资料 <a class="a-post" href="/article/StudyShare/post/704">回复</a></td></tr></table></div>';
      document.getElementById('original-link').addEventListener('click',event=>{event.preventDefault();globalThis.linkClicks=(globalThis.linkClicks||0)+1;});};</script>
      <script src="/content.js"></script><script>setTimeout(renderPosts,200);</script>`);
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }
});

server.listen(0, "127.0.0.1", () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "byr-integration-"));
  const browser = process.env.BYR_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const proc = spawn(browser, [
    "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--user-data-dir=" + profile, "--remote-debugging-port=0", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let connected = false;
  const timer = setTimeout(() => { console.error("浏览器测试超时"); process.exitCode = 1; proc.kill("SIGTERM"); server.close(); }, 25000);
  proc.on("error", (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; server.close(); });
  proc.stderr.on("data", async (data) => {
    stderr += data;
    const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (!match || connected) return;
    connected = true;
    let socket;
    try {
      const pages = await (await fetch("http://127.0.0.1:" + match[1] + "/json/list")).json();
      socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let id = 0;
      const pending = new Map();
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
      };
      const command = (method, params = {}) => new Promise((resolve) => {
        const next = ++id; pending.set(next, resolve); socket.send(JSON.stringify({ id: next, method, params }));
      });
      await command("Page.navigate", { url: "http://127.0.0.1:" + server.address().port });
      let result;
      let phase;
      for (let count = 0; count < 100; count += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const value = await command("Runtime.evaluate", {
          expression: "JSON.stringify({result:document.getElementById('integration-result')?.textContent,phase:document.documentElement.dataset.smoke})", returnByValue: true
        });
        const status = JSON.parse(value.result.result.value);
        phase = status.phase;
        if (status.result) { result = JSON.parse(status.result); break; }
      }
      if (!result) throw new Error("浏览器未返回测试结果，阶段：" + phase);
      if (!result.ok) throw new Error(result.error);
      await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      const evaluate = async (expression) => {
        const value = await command('Runtime.evaluate', { expression, returnByValue: true });
        if (value.result.exceptionDetails) throw new Error(value.result.exceptionDetails.text);
        return value.result.result.value;
      };
      const background = JSON.parse(await evaluate(`scrollTo(0,0);globalThis.smokeBackgroundClicks=0;document.getElementById('manual-board-details').open=false;document.querySelector('#manual-board-details > summary').addEventListener('click',()=>globalThis.smokeBackgroundClicks++);const target=document.querySelector('#manual-board-details > summary').getBoundingClientRect();document.getElementById('open-settings').click();JSON.stringify({x:target.left+15,y:target.top+target.height/2})`));
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...background, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...background, button: 'left', clickCount: 1 });
      if (!await evaluate(`smokeBackgroundClicks===0 && !document.getElementById('manual-board-details').open && document.getElementById('search-settings').matches(':modal')`)) throw new Error('模态弹窗未阻止鼠标点击主界面');
      if (!await evaluate(`document.getElementById('query-input').focus();document.activeElement!==document.getElementById('query-input')`)) throw new Error('主界面输入框能获取模态窗口外的键盘焦点');
      for (let count = 0; count < 8; count += 1) {
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        if (!await evaluate(`document.activeElement===document.body || document.getElementById('search-settings').contains(document.activeElement)`)) throw new Error('键盘焦点逃出模态弹窗');
      }
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      if (!await evaluate(`!document.getElementById('search-settings').open && document.getElementById('search-settings').hidden`)) throw new Error('Escape没有关闭弹窗');
      result.modalBlocksBackground = true;
      const checkLayout = async (expanded, width, modal = false) => {
        await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        const value = await command("Runtime.evaluate", {
          expression: `document.getElementById('scope-presets-details').open=${expanded};document.getElementById('manual-board-details').open=${!expanded};document.getElementById('integration-result').hidden=true;scrollTo(0,0);JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,settingsHidden:document.getElementById('search-settings').hidden,sidebarWidth:document.getElementById('settings-preferences-panel').clientWidth,sidebarScroll:document.getElementById('settings-preferences-panel').scrollWidth,sidebarLeft:document.getElementById('settings-preferences-panel').getBoundingClientRect().left,searchLeft:document.querySelector('.search-panel').getBoundingClientRect().left})`, returnByValue: true
        });
        const layout = JSON.parse(value.result.result.value);
        if (layout.scroll > layout.width) throw new Error("页面出现横向溢出：" + JSON.stringify(layout));
        if (layout.sidebarScroll > layout.sidebarWidth) throw new Error("侧栏出现横向溢出：" + JSON.stringify(layout));
        if (width > 1040 && layout.sidebarLeft >= layout.searchLeft) throw new Error("桌面侧栏没有位于搜索区左侧");
        if (modal) {
          const modalLayout = JSON.parse(await evaluate(`(()=>{document.getElementById('open-settings').click();const dialog=document.getElementById('search-settings');const box=dialog.getBoundingClientRect();return JSON.stringify({left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:dialog.clientWidth,scroll:dialog.scrollWidth});})()`));
          if (modalLayout.left < 0 || modalLayout.right > width || modalLayout.top < 0 || modalLayout.bottom > 900 || modalLayout.scroll > modalLayout.width) throw new Error('弹窗超出窗口或横向溢出：' + JSON.stringify(modalLayout));
          layout.modal = modalLayout;
        }
        if (process.env.BYR_TEST_SCREENSHOT_DIR) {
          const screenshot = await command("Page.captureScreenshot", { format: "png" });
          const name = modal ? (width < 600 ? 'settings-mobile.png' : 'settings-desktop.png') : width < 600 ? (expanded ? 'range-sidebar-mobile.png' : 'search-mobile.png') : expanded ? 'range-sidebar-editor.png' : 'search-home.png';
          fs.writeFileSync(path.join(process.env.BYR_TEST_SCREENSHOT_DIR, name), Buffer.from(screenshot.result.data, "base64"));
        }
        if (modal) await evaluate(`document.getElementById('close-settings').click()`);
        return layout;
      };
      result.layouts = [await checkLayout(false, 1280), await checkLayout(true, 1280), await checkLayout(false, 390), await checkLayout(true, 390), await checkLayout(false, 1280, true), await checkLayout(false, 390, true)];
      // 使用真实 DOM 重现横幅与帖子共用 article 类，以及单页路由延迟替换正文。
      await command('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/jump#!article/StudyShare/7?byr_article_id=700&byr_highlight=' + encodeURIComponent('资料|teacher|C++') });
      const waitForHighlight = async (id) => {
        for (let count = 0; count < 50; count += 1) {
          if (await evaluate(`document.querySelector('.byr-search-jump-highlight')?.id === '${id}'`)) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error('论坛跳转没有高亮指定帖子：' + id);
      };
      await waitForHighlight('post0');
      if (await evaluate(`document.getElementById('banner').classList.contains('byr-search-jump-highlight')`)) throw new Error('主题跳转错误高亮了论坛横幅');
      if (!await evaluate(`(()=>{const matches=[...CSS.highlights.get('byr-search-terms')];return matches.length===5 && matches.filter(range=>range.toString()==='资料').length===3 && matches.some(range=>range.toString()==='TeAcHer') && matches.some(range=>range.toString()==='C++') && matches.every(range=>document.getElementById('post0').contains(range.commonAncestorContainer));})()`)) throw new Error('文字高亮应支持跨标签、大小写和正则特殊字符，且只匹配目标帖正文和作者');
      if (!await evaluate(`document.getElementById('original-link').click();linkClicks===1 && document.querySelector('#post0 b').textContent==='资' && !document.querySelector('#post0 mark')`)) throw new Error('文字高亮不能改变原有标签或破坏链接事件');
      await evaluate(`location.hash='!article/StudyShare/7?p=1&byr_article_id=704&byr_highlight=资料#a4'`);
      await waitForHighlight('post4');
      if (!await evaluate(`document.querySelector('.byr-search-jump-badge').textContent.includes('搜索命中 · 第 4 楼 · 1 处')`)) throw new Error('回帖高亮楼层标记错误');
      if (!await evaluate(`CSS.highlights.get('byr-search-terms').size===1 && [...CSS.highlights.get('byr-search-terms')][0].toString()==='资料'`)) throw new Error('跳到回帖时应移除楼主文字高亮，仅保留回帖命中');
      await evaluate(`document.querySelector('#post4 .a-content-wrap').firstChild.data='新增资料和资料'`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!await evaluate(`CSS.highlights.get('byr-search-terms').size===2`)) throw new Error('同一帖文字延迟更新后应重新匹配');
      await evaluate(`location.hash='!article/StudyShare/8?byr_highlight=资料';setTimeout(renderPosts,100)`);
      await waitForHighlight('post0');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await waitForHighlight('post0');
      if (!await evaluate(`document.querySelectorAll('.byr-search-jump-badge').length===1`)) throw new Error('论坛重新渲染后应只保留一个高亮标记');
      await evaluate(`location.hash='!board/StudyShare'`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (await evaluate(`!!document.querySelector('.byr-search-jump-highlight,.byr-search-jump-badge')`)) throw new Error('离开搜索目标后应清除高亮');
      if (await evaluate(`CSS.highlights.has('byr-search-terms')`)) throw new Error('离开搜索目标后应清除文字高亮');
      await evaluate(`location.hash='!article/StudyShare/9?byr_article_id=999&byr_highlight=资料'`);
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (!await evaluate(`!!document.querySelector('.byr-search-jump-status') && document.querySelector('.byr-search-jump-status').textContent.includes('未找到目标')`)) throw new Error('找不到目标时应显示定位失败提示');
      await evaluate(`document.getElementById('posts').insertAdjacentHTML('beforeend','<div class="a-wrap" id="post9"><div class="a-content-wrap">延迟资料 <a class="a-post" href="/article/StudyShare/post/999">回复</a></div></div>');document.querySelector('.byr-search-jump-status button').click()`);
      await waitForHighlight('post9');
      if (await evaluate(`!!document.querySelector('.byr-search-jump-status')`)) throw new Error('重新定位成功后应移除失败提示');
      result.jumpHighlights = { thread: true, reply: true, exactArticleId: true, delayedRender: true, bannerExcluded: true, textRanges: true, crossInlineTags: true, linksPreserved: true, textUpdates: true, failureRetry: true };
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(error.message); process.exitCode = 1;
    } finally {
      clearTimeout(timer); socket?.close(); proc.kill("SIGTERM"); server.close();
    }
  });
});
