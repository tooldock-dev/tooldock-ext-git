'use strict';
/**
 * Git 工具後端：儲存庫清單、git 操作的排隊與進度、儲存庫異動監看。
 *
 * - 會修改儲存庫的操作一次只執行一個（排隊），避免同時搶 index.lock。
 * - 網路操作（clone、fetch、pull、push）回報進度，可以取消。
 * - 執行過的 git 指令與輸出保留最近 200 筆，畫面「輸出」面板可以查看。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const G = require('./git');
const ops = require('./ops');

let ctx = null;
let git = null;
let pendingCommand = null;
let queue = Promise.resolve();
let running = null; // { id, title, cancel }
let watcher = null;
let watchTimer = null;
const output = [];

const setting = (k, d) => {
  const v = ctx.settings.get(`gitTool.${k}`, d);
  return v === undefined || v === null || v === '' ? d : v;
};

/* ───────────── 輸出紀錄 ───────────── */

function onLog(entry) {
  const e = { time: Date.now(), cmd: `git ${entry.args.map(quoteArg).join(' ')}`, cwd: entry.cwd || '', ok: entry.ok, ms: entry.ms, output: entry.output || '', message: entry.message || '' };
  output.push(e);
  if (output.length > 200) output.shift();
  if (ctx) ctx.ui.emit('output', e);
}

function quoteArg(a) {
  return /^[\w@%+=:,./{}^~-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

/* ───────────── 儲存庫清單 ───────────── */

const repos = () => ctx.storage.get('repos', []);

function repo(id) {
  const r = repos().find((x) => x.id === id);
  if (!r) throw new Error('找不到這個儲存庫，請重新選擇');
  if (!fs.existsSync(r.root)) throw new Error(`資料夾不存在：${r.root}`);
  return r;
}

async function addRepo(dir, name) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('資料夾路徑不正確');
  if (!fs.existsSync(dir)) throw new Error('資料夾不存在');
  const top = await ops.topLevel(git, dir);
  if (!top) {
    const e = new Error('這個資料夾不是 Git 儲存庫');
    e.code = 'NOT_REPO';
    throw e;
  }
  const list = repos();
  const same = list.find((r) => path.resolve(r.root) === top);
  if (same) return { repo: same, existed: true, repos: list };
  const r = { id: crypto.randomUUID(), name: String(name || '').trim().slice(0, 100) || path.basename(top) || top, root: top, addedAt: Date.now() };
  const next = [...list, r];
  ctx.storage.set('repos', next);
  ctx.log.info(`加入儲存庫「${r.name}」：${r.root}`);
  return { repo: r, existed: false, repos: next };
}

function renameRepo({ id, name }) {
  const n = String(name || '').trim().slice(0, 100);
  if (!n) throw new Error('名稱不能是空的');
  const next = repos().map((r) => (r.id === id ? { ...r, name: n } : r));
  ctx.storage.set('repos', next);
  return next;
}

function removeRepo(id) {
  const next = repos().filter((r) => r.id !== id);
  ctx.storage.set('repos', next);
  if (ctx.storage.get('lastRepo') === id) ctx.storage.set('lastRepo', next[0] ? next[0].id : null);
  if (watcher && watcher.id === id) unwatch();
  return next;
}

/* ───────────── 監看 .git ───────────── */

function unwatch() {
  if (watcher) { try { watcher.w.close(); } catch { /* 忽略 */ } }
  watcher = null;
  clearTimeout(watchTimer);
}

/** 監看 .git 資料夾（HEAD、index、refs 的變化），在外部執行 git 指令後通知畫面重新整理 */
async function watch(id) {
  unwatch();
  if (!id) return;
  let dir;
  try { dir = await ops.gitDir(git, repo(id).root); } catch { return; }
  try {
    const w = fs.watch(dir, { persistent: false }, (ev, file) => {
      if (file && /\.lock$/.test(String(file))) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => ctx.ui.emit('repoChanged', { id }), 400);
    });
    w.on('error', () => unwatch());
    watcher = { id, w };
  } catch { /* 無法監看時只靠畫面的手動重新整理 */ }
}

/* ───────────── 排隊與進度 ───────────── */

/** 會修改儲存庫的操作排隊執行 */
function exclusive(title, fn) {
  const job = queue.then(async () => {
    ctx.ui.emit('busy', { title });
    try {
      return await fn();
    } finally {
      ctx.ui.emit('busy', null);
    }
  });
  queue = job.catch(() => {});
  return job;
}

/** 網路操作：回報進度、可取消、有逾時 */
function network(title, fn) {
  return exclusive(title, async () => {
    const id = crypto.randomUUID();
    running = { id, title, cancel: null };
    ctx.ui.emit('progress', { id, title, text: '' });
    let last = 0;
    let buf = '';
    const net = {
      timeout: Math.max(10, Number(setting('networkTimeout', 600)) || 600) * 1000,
      onSpawn: (cancel) => { if (running && running.id === id) running.cancel = cancel; },
      onProgress: (chunk) => {
        buf = (buf + chunk).slice(-2000);
        const now = Date.now();
        if (now - last < 120) return;
        last = now;
        const line = buf.split(/\r|\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
        ctx.ui.emit('progress', { id, title, text: line });
      },
    };
    try {
      return await fn(net);
    } finally {
      running = null;
      ctx.ui.emit('progress', null);
    }
  });
}

/** 錯誤帶上代碼，畫面才能決定後續動作（例如設定身分、強制推送） */
function wrap(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const e = new Error(err.code && !/^E[A-Z]+$/.test(err.code) ? `[${err.code}] ${err.message}` : err.message);
      throw e;
    }
  };
}

/* ───────────── 啟用 ───────────── */

exports.activate = (context) => {
  ctx = context;
  git = G.createRunner({ gitPath: () => setting('gitPath', ''), onLog });
  const h = (name, fn) => ctx.ui.handle(name, wrap(fn));
  const top = (id) => repo(id).root;

  h('info', async () => {
    const last = ctx.storage.get('lastRepo', null);
    let version = '';
    try { version = await git.version(); } catch (err) { version = ''; if (err.code !== 'NO_GIT') ctx.log.warn(err.message); }
    return {
      settings: ctx.settings.all(),
      repos: repos(),
      lastRepo: last,
      gitVersion: version,
      platform: ctx.platform && ctx.platform.version,
      sep: path.sep,
      home: os.homedir(),
      busy: running ? { title: running.title } : null,
    };
  });

  /* 儲存庫清單 */
  h('addRepo', ({ root, name }) => addRepo(root, name));
  h('renameRepo', (o) => renameRepo(o));
  h('removeRepo', (id) => removeRepo(id));
  h('selectRepo', async (id) => {
    ctx.storage.set('lastRepo', id || null);
    await watch(id);
    return true;
  });
  h('initRepo', ({ root }) => exclusive('建立儲存庫', async () => {
    const dir = await ops.init(git, root);
    return addRepo(dir);
  }));
  h('clone', ({ url, parent, name }) => network('複製儲存庫', async (net) => {
    const dest = await ops.clone(git, { url, parent, name }, net);
    return addRepo(dest);
  }));
  h('defaults', () => ({ cloneDir: setting('cloneDir', '') || os.homedir() }));
  h('repoName', (url) => ops.repoNameFromUrl(url));

  /* 讀取 */
  h('status', ({ id }) => ops.status(git, top(id)));
  h('diff', ({ id, ...o }) => ops.diffSides(git, top(id), o));
  h('log', ({ id, ...o }) => ops.log(git, top(id), { limit: setting('logLimit', 300), ...o }));
  h('commit:info', ({ id, hash }) => ops.commitInfo(git, top(id), hash));
  h('commit:diff', ({ id, ...o }) => ops.commitDiff(git, top(id), o));
  h('branches', ({ id }) => ops.branches(git, top(id)));
  h('stashes', ({ id }) => ops.stashes(git, top(id)));
  h('stash:files', ({ id, ref }) => ops.stashFiles(git, top(id), { ref }));
  h('identity', ({ id }) => ops.identity(git, top(id)));
  h('conflict:info', ({ id, path: p }) => ops.conflictInfo(git, top(id), { path: p }));
  h('output', () => output.slice());
  h('reveal', ({ id }) => ctx.shell.showItemInFolder(top(id)));
  h('openFile', ({ id, path: p }) => ctx.shell.openPath(path.join(top(id), G.safeRel(top(id), p))));

  /* 修改 */
  const ex = (name, title, fn) => h(name, (o) => exclusive(title, () => fn(o)));
  ex('stage', '暫存', ({ id, paths }) => ops.stage(git, top(id), paths));
  ex('unstage', '取消暫存', ({ id, paths, noCommits }) => ops.unstage(git, top(id), paths, { noCommits }));
  ex('stageAll', '暫存全部', ({ id }) => ops.stageAll(git, top(id)));
  ex('unstageAll', '取消暫存全部', ({ id, noCommits }) => ops.unstageAll(git, top(id), { noCommits }));
  ex('discard', '捨棄變更', ({ id, tracked, untracked }) => ops.discard(git, top(id), { tracked, untracked }));
  ex('commit', '提交', ({ id, message, amend }) => ops.commit(git, top(id), { message, amend }));
  ex('setIdentity', '設定身分', ({ id, name, email, global }) => ops.setIdentity(git, top(id), { name, email, global }));
  ex('checkout', '切換', ({ id, ...o }) => ops.checkout(git, top(id), o));
  ex('createBranch', '建立分支', ({ id, ...o }) => ops.createBranch(git, top(id), o));
  ex('deleteBranch', '刪除分支', ({ id, ...o }) => ops.deleteBranch(git, top(id), o));
  ex('renameBranch', '重新命名分支', ({ id, ...o }) => ops.renameBranch(git, top(id), o));
  ex('createTag', '建立標籤', ({ id, ...o }) => ops.createTag(git, top(id), o));
  ex('deleteTag', '刪除標籤', ({ id, ...o }) => ops.deleteTag(git, top(id), o));
  ex('merge', '合併', ({ id, ...o }) => ops.merge(git, top(id), o));
  ex('cherryPick', '揀選提交', ({ id, ...o }) => ops.cherryPick(git, top(id), o));
  ex('revert', '還原提交', ({ id, ...o }) => ops.revert(git, top(id), o));
  ex('reset', '重設分支', ({ id, ...o }) => ops.reset(git, top(id), o));
  ex('abort', '中止', ({ id }) => ops.abortOp(git, top(id)));
  ex('continue', '繼續', ({ id, message }) => ops.continueOp(git, top(id), { message }));
  ex('addRemote', '新增遠端', ({ id, ...o }) => ops.addRemote(git, top(id), o));
  ex('removeRemote', '移除遠端', ({ id, ...o }) => ops.removeRemote(git, top(id), o));
  ex('stash', '儲藏', ({ id, ...o }) => ops.stashPush(git, top(id), o));
  ex('stash:apply', '套用儲藏', ({ id, ...o }) => ops.stashApply(git, top(id), o));
  ex('stash:drop', '刪除儲藏', ({ id, ...o }) => ops.stashDrop(git, top(id), o));
  ex('conflict:resolve', '標示已解決', ({ id, ...o }) => ops.resolveText(git, top(id), o));
  ex('conflict:take', '採用版本', ({ id, ...o }) => ops.takeSide(git, top(id), o));
  ex('conflict:mark', '標示已解決', ({ id, ...o }) => ops.markResolved(git, top(id), o));

  /* 網路 */
  h('fetch', ({ id }) => network('擷取', (net) => ops.fetchAll(git, top(id), net)));
  h('pull', ({ id }) => network('拉取', (net) => ops.pull(git, top(id), { mode: setting('pullMode', 'merge') }, net)));
  h('push', ({ id, ...o }) => network('推送', (net) => ops.push(git, top(id), o, net)));
  h('deleteRemoteBranch', ({ id, ...o }) => network('刪除遠端分支', (net) => ops.deleteRemoteBranch(git, top(id), o, net)));
  h('cancel', () => {
    if (running && running.cancel) { running.cancel(); return true; }
    return false;
  });

  h('takePending', () => {
    const c = pendingCommand;
    pendingCommand = null;
    return c;
  });

  const toView = async (command) => {
    pendingCommand = command;
    await ctx.window.openView('gitTool.main');
    ctx.ui.emit('command', { command });
  };
  ctx.subscriptions.push(
    ctx.commands.register('gitTool.open', () => ctx.window.openView('gitTool.main')),
    ctx.commands.register('gitTool.clone', () => toView('clone')),
    ctx.commands.register('gitTool.addRepo', () => toView('addRepo')),
    ctx.commands.register('gitTool.pull', () => toView('pull')),
    ctx.commands.register('gitTool.push', () => toView('push')),
    ctx.commands.register('gitTool.fetch', () => toView('fetch')),
    ctx.settings.onDidChange((key) => ctx.ui.emit('settingsChanged', { key, settings: ctx.settings.all() })),
    { dispose: () => { unwatch(); if (running && running.cancel) running.cancel(); } },
  );
};

/** 其他擴充呼叫受保護指令（拉取、推送）時，確認對話框顯示的說明 */
exports.guardSummary = (context, command) => {
  const list = context.storage.get('repos', []);
  const r = list.find((x) => x.id === context.storage.get('lastRepo', null)) || list[0];
  const name = r ? `「${r.name}」（${r.root}）` : '目前選取的儲存庫';
  if (command === 'gitTool.push') return `把${name}目前分支的提交推送到遠端`;
  if (command === 'gitTool.pull') return `從遠端拉取提交並合併到${name}的目前分支`;
  return null;
};

exports.deactivate = () => {
  pendingCommand = null;
  unwatch();
};

// 測試用
exports._internal = { addRepo, renameRepo, removeRepo, exclusive, setContext: (c) => { ctx = c; git = G.createRunner({ onLog }); } };
