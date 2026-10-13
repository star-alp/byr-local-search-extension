/* 邮人全搜分页任务队列：边读取边处理，支持暂停、恢复、失败重试和真实覆盖统计。 */

globalThis.ByrTasks = (() => {
  const knownJobs = new WeakMap();
  function create(mode, boards, options, query = "") {
    return { id: String(Date.now()), mode, boards, options, query, jobs: [], phase: "paused", requests: 0, pauseRequested: false };
  }

  function enqueue(task, job) {
    const id = `${job.kind}:${job.board.name}:${job.post?.gid || job.path || ""}:${job.page || 1}`;
    if (!knownJobs.has(task)) knownJobs.set(task, new Set(task.jobs.map((item) => item.id)));
    const ids = knownJobs.get(task);
    if (ids.has(id)) return;
    ids.add(id);
    const item = { ...job, id, status: "pending" };
    task.jobs.push(item);
  }

  function nextJob(task) {
    const pending = task.jobs.filter((job) => job.status === "pending");
    const articles = pending.filter((job) => job.kind === "article");
    let discovery = pending.filter((job) => job.kind !== "article");
    // 目录与正文交替；目录优先覆盖各版面的第一页，正文按版面轮转。
    const firstPages = discovery.filter((job) => job.page === 1);
    if (firstPages.length) discovery = firstPages;
    const kind = (task.nextKind === "article" && articles.length) || !discovery.length ? "article" : "discovery";
    const candidates = kind === "article" ? articles : discovery;
    const cursorKey = `${kind}Cursor`;
    for (let offset = 0; offset < task.boards.length; offset += 1) {
      const index = ((task[cursorKey] || 0) + offset) % task.boards.length;
      const job = candidates.find((item) => item.board.name === task.boards[index].name);
      if (!job) continue;
      task[cursorKey] = (index + 1) % task.boards.length;
      task.nextKind = kind === "article" ? "discovery" : "article";
      return job;
    }
    return null;
  }

  function snapshot(task) {
    const saved = structuredClone(task);
    saved.jobs.forEach((job) => { if (job.status === "running") job.status = "pending"; });
    saved.pauseRequested = false;
    if (saved.phase === "running") saved.phase = "paused";
    return saved;
  }

  function metrics(task) {
    const boardStates = new Map();
    const threads = new Set();
    const failures = [];
    let boardPages = 0;
    let nativePages = 0;
    let contentPages = 0;
    let done = 0;
    task.jobs.forEach((job) => {
      boardStates.set(job.board.name, (boardStates.get(job.board.name) ?? true) && job.status === "done");
      if (job.status === "failed") failures.push(job);
      if (job.status !== "done") return;
      done += 1;
      if (job.kind === "board") boardPages += 1;
      if (job.kind === "native") nativePages += 1;
      if (job.kind === "article") { contentPages += 1; threads.add(`${job.board.name}:${job.post.gid}`); }
    });
    const boards = task.boards.filter((board) => boardStates.get(board.name) === true).length;
    return { boards, boardTotal: task.boards.length, boardPages, nativePages, contentPages, threads: threads.size, failures, done, total: task.jobs.length };
  }

  function run(task, worker, concurrency, notify, schedulers) {
    task.phase = "running";
    task.pauseRequested = false;
    task.error = "";
    return new Promise((resolve) => {
      let active = 0;
      let finished = false;
      const schedule = () => {
        if (finished) return;
        while (!task.pauseRequested && active < concurrency()) {
          const job = nextJob(task);
          if (!job) break;
          job.status = "running";
          active += 1;
          Promise.resolve().then(() => worker(job))
            .then(() => { job.status = "done"; delete job.error; })
            .catch((error) => {
              if (error.name === "AbortError" || error.fatal || String(error.message).includes("登录")) {
                job.status = "pending";
                task.pauseRequested = true;
                if (error.name !== "AbortError") task.error = error.message;
              } else {
                job.status = "failed";
                job.error = error.message || "请求失败";
              }
            })
            .finally(() => { active -= 1; schedule(); });
        }
        if (active === 0 && (task.pauseRequested || !task.jobs.some((job) => job.status === "pending"))) {
          finished = true;
          schedulers.delete(schedule);
          task.phase = task.pauseRequested ? "paused" : task.jobs.some((job) => job.status === "failed") ? "partial" : "complete";
          notify(active);
          resolve();
          return;
        }
        notify(active);
      };
      schedulers.add(schedule);
      schedule();
    });
  }

  return { create, enqueue, snapshot, metrics, run };
})();
