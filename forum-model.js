/* 邮人全搜论坛数据模型：把论坛返回的多种字段统一成插件内部使用的主题和文章标识。 */

(function installByrForumModel() {
  if (globalThis.ByrForumModel) return;

  function firstValue(...values) {
    return values
      .map((value) => String(value ?? "").trim())
      .find(Boolean) || "";
  }

  function threadId(post) {
    // nForum 的主题列表通常同时含有 id、group_id；原主题删除后两者可能不一致。
    return firstValue(post?.gid, post?.id, post?.group_id);
  }

  function articleId(article) {
    return firstValue(article?.id, article?.ID, article?.article_id);
  }

  function normalizeBoardPost(post) {
    const id = threadId(post);
    return {
      ...post,
      threadId: id,
      gid: id,
      title: String(post?.title ?? ""),
      author: post?.poster || post?.user || "",
      replyCount: post?.replyCount ?? post?.reply_count ?? post?.replyNum ?? post?.articleNum ?? null,
      time: post?.postTime || post?.post_time || post?.lastReplyTime || post?.last_reply_time || post?.time || null
    };
  }

  function normalizeArticle({ board, boardDescription, post, result, article, toText }) {
    const text = typeof toText === "function" ? toText : (value) => String(value || "");
    const position = Number(article?.pos ?? article?.position) || 0;
    const thread = threadId(post);
    const id = articleId(article);
    const articleUser = article?.poster || article?.user;
    const postUser = post?.poster || post?.user;
    const author = articleUser?.id || articleUser || postUser?.id || postUser || "已注销";
    const authorName = articleUser?.user_name || articleUser?.username || "";
    return {
      id: position === 0 ? `thread:${board}:${thread}` : `reply:${board}:${thread}:${position}`,
      type: position === 0 ? "thread" : "reply",
      board,
      boardDescription,
      gid: thread,
      threadId: thread,
      title: text(result?.data?.title || post?.title),
      content: text(article?.content),
      contentFetched: true,
      author,
      authorName,
      articleId: id,
      pos: position,
      time: article?.time ?? article?.post_time ?? (position === 0 ? normalizeBoardPost(post).time : null),
      replyCount: normalizeBoardPost(post).replyCount
    };
  }

  globalThis.ByrForumModel = Object.freeze({ threadId, articleId, normalizeBoardPost, normalizeArticle });
})();
