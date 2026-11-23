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
const P = require('./project');
const S = require('./ssh');

let ctx = null;
let git = null;
let pendingCommand = null; // 畫面還沒開時收到的指令：字串，或匯入專案時的物件 { command, ... }
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

/* ───────────── 專案交換（git-tool.project） ───────────── */

/** 把指令交給畫面；畫面還沒載入完成時，啟動後由 takePending 取得 */
function toUi(command) {
  pendingCommand = command;
  ctx.ui.emit('command', { command });
}

/** 儲存庫的 git-tool.project payload；forFile 時不帶本機路徑（給別人） */
async function projectPayload(id, { forFile = false, file, line } = {}) {
  const r = repo(id);
  const d = await ops.describe(git, r.root);
  return P.buildPayload({ name: r.name, root: r.root, remotes: d.remotes, branch: d.branch, file, line }, { forFile });
}

/** 清單中遠端網址相同的儲存庫 */
async function reposWithRemote(remotes) {
  const out = [];
  for (const r of repos()) {
    if (!fs.existsSync(r.root)) continue;
    try {
      const d = await ops.describe(git, r.root);
      if (d.remotes.some((x) => remotes.some((y) => P.sameRemote(x.url, y.url)))) out.push({ id: r.id, name: r.name, root: r.root });
    } catch { /* 無法讀取的儲存庫略過 */ }
  }
  return out;
}

/** 交給其他工具開啟（例如程式碼編輯器）；沒有接收端時不另存檔案 */
async function openIn(id, { file, line, receiver } = {}) {
  if (!ctx.exchange) throw new Error('需要 ToolDock 1.4.0 以上才能在其他工具開啟');
  const payload = await projectPayload(id, { file, line });
  const pkg = ctx.exchange.create(P.TYPE, payload, { title: file ? `${payload.name}：${file}` : payload.name, description: payload.path });
  const res = await ctx.exchange.share(pkg, { fallback: 'none', ...(receiver ? { preferReceiver: receiver } : {}) });
  if (res.status === 'no-receiver') throw new Error('沒有可以開啟專案的工具，可以到擴充商店安裝「程式碼編輯器」');
  if (res.status === 'error') throw new Error(res.message || '無法交給其他工具');
  if (res.status === 'delivered' && res.result && res.result.status === 'rejected') throw new Error(res.result.message || '對方無法開啟這個專案');
  return { status: res.status, receiver: res.receiver || null, message: res.result && res.result.message };
}

/** 存成 .tdx 交換檔給別人：只帶遠端網址與分支 */
async function shareFile(id) {
  if (!ctx.exchange) throw new Error('需要 ToolDock 1.4.0 以上才能分享專案');
  const payload = await projectPayload(id, { forFile: true });
  const pkg = ctx.exchange.create(P.TYPE, payload, {
    title: payload.name,
    description: `${payload.remotes[0].url}${payload.branch ? `（${payload.branch} 分支）` : ''}`,
  });
  // eslint-disable-next-line no-control-regex
  const safe = payload.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'project';
  const r = await ctx.window.showSaveDialog({ title: '分享專案：存成交換檔', defaultPath: path.join(os.homedir(), `${safe}.tdx`), filters: [{ name: 'ToolDock 交換檔', extensions: ['tdx'] }] });
  if (!r || r.canceled || !r.filePath) return null;
  const file = /\.tdx$/i.test(r.filePath) ? r.filePath : `${r.filePath}.tdx`;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  ctx.log.info(`分享專案「${payload.name}」：${file}`);
  return { filePath: file, remote: payload.remotes[0].url, branch: payload.branch || '' };
}

/**
 * 接收 git-tool.project：
 * - 帶本機路徑（同一台電腦的其他工具）：加入清單並選取；不是儲存庫時由畫面詢問是否建立。
 * - 從 .tdx 檔或路徑不存在：由畫面開啟帶好網址的複製對話框，使用者確認後才下載。
 */
async function importProject(pkg, info = {}) {
  const res = await importProjectInner(pkg, info);
  // 平台不會顯示接收端的拒絕原因，自己告訴使用者
  if (res.status === 'rejected') ctx.window.toast(res.message, 'warn').catch(() => {});
  return res;
}

async function importProjectInner(pkg, info) {
  let p;
  try {
    p = P.parsePayload(pkg && pkg.payload, { origin: info.origin });
  } catch (err) {
    return { status: 'rejected', message: err.message };
  }
  const from = info.producer ? `（來自 ${info.producer.name}）` : '';
  if (p.path && fs.existsSync(p.path)) {
    let top;
    try { top = await ops.topLevel(git, p.path); } catch (err) { return { status: 'rejected', message: err.message }; }
    if (!top) {
      toUi({ command: 'addRepo', dir: p.path });
      return { status: 'imported', message: `「${p.name}」還不是 Git 儲存庫，已在 Git 工具詢問是否建立` };
    }
    const res = await addRepo(top, top === p.path ? p.name : '');
    ctx.storage.set('lastRepo', res.repo.id);
    toUi({ command: 'openRepo', id: res.repo.id });
    ctx.log.info(`開啟專案「${res.repo.name}」${from}：${res.repo.root}`);
    return { status: 'imported', message: `已在 Git 工具開啟「${res.repo.name}」`, data: { repoId: res.repo.id, root: res.repo.root, added: !res.existed } };
  }
  if (!p.remotes.length) return { status: 'rejected', message: `資料夾不存在：${p.path}` };
  const existing = await reposWithRemote(p.remotes);
  toUi({ command: 'cloneProject', project: { name: p.name, remotes: p.remotes, branch: p.branch }, existing, origin: info.origin === 'file' ? 'file' : 'share' });
  ctx.log.info(`收到專案「${p.name}」${from}：${p.remotes[0].url}`);
  return { status: 'imported', message: existing.length ? `已在 Git 工具開啟「${existing[0].name}」的選項` : `已在 Git 工具開啟複製畫面，確認後才會下載「${p.name}」` };
}

/* ───────────── SSH 金鑰 ───────────── */

/** core.sshCommand 的值 → { value, key（~/.ssh 中的金鑰名稱）, keyFile, custom } */
function describeSshCommand(value) {
  const r = S.parseSshCommand(value);
  const dir = S.sshDir();
  const key = r.keyFile && path.dirname(path.resolve(r.keyFile)) === path.resolve(dir) ? path.basename(r.keyFile) : null;
  return { value: value || '', key, keyFile: r.keyFile, custom: r.custom };
}

/** SSH 面板需要的全部資料；id 可省略（還沒有選儲存庫時） */
async function sshState(id) {
  let top = null;
  try { if (id) top = repo(id).root; } catch { top = null; }
  const cmds = await ops.sshCommands(git, top);
  let remotes = [];
  let email = '';
  if (top) {
    try { remotes = (await ops.describe(git, top)).remotes; } catch { remotes = []; }
    try { email = (await ops.identity(git, top)).email; } catch { email = ''; }
  } else {
    try { email = (await git.text(['config', '--global', '--get', 'user.email'], undefined, { quiet: true })).trim(); } catch { email = ''; }
  }
  return {
    dir: S.sshDir(),
    keys: S.listKeys(),
    repo: top ? { id, root: top, name: repo(id).name } : null,
    local: describeSshCommand(cmds.local),
    global: describeSshCommand(cmds.global),
    remotes: remotes.map((r) => ({ name: r.name, url: r.url, ssh: S.parseSshUrl(r.url), sshUrl: S.parseSshUrl(r.url) ? null : S.httpsToSsh(r.url) })),
    email,
    suggest: { ed25519: S.suggestName('ed25519'), rsa: S.suggestName('rsa') },
    pages: S.ADD_KEY_PAGES,
  };
}

/** 切換金鑰：key 為空字串時恢復成 ssh 預設（移除 core.sshCommand） */
async function useKey({ id, scope, key }) {
  const top = scope === 'local' ? repo(id).root : (id ? repo(id).root : null);
  const value = key ? S.sshCommandFor(S.keyFileOf(key)) : '';
  await ops.setSshCommand(git, top, { scope, value });
  ctx.log.info(`SSH 金鑰（${scope === 'local' ? `儲存庫 ${top}` : '全域'}）：${key || (scope === 'local' ? '跟隨全域設定' : '使用 ssh 預設')}`);
  return sshState(id);
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
  h('clone', ({ url, parent, name, branch, sshKey }) => network('複製儲存庫', async (net) => {
    const sshCommand = sshKey ? S.sshCommandFor(S.keyFileOf(sshKey)) : '';
    const dest = await ops.clone(git, { url, parent, name, branch, sshCommand }, net);
    return addRepo(dest);
  }));
  h('defaults', () => ({ cloneDir: setting('cloneDir', '') || os.homedir() }));
  h('repos', () => repos());

  /* SSH 金鑰 */
  h('ssh:state', ({ id } = {}) => sshState(id));
  h('ssh:keys', () => S.listKeys());
  h('ssh:publicKey', (name) => S.publicKey(name));
  h('ssh:generate', async (o) => {
    try { await git.version(); } catch { /* 只是為了確定 git 的位置（Windows 上找 Git 附帶的 ssh-keygen） */ }
    const r = await S.generate(o, { gitBin: git.bin() });
    ctx.log.info(`產生 SSH 金鑰 ${r.file}（${r.fingerprint}）`);
    return r;
  });
  h('ssh:test', async ({ host, user, port, key }) => {
    try { await git.version(); } catch { /* 同上 */ }
    return S.testConnection({ host, user, port, keyFile: key ? S.keyFileOf(key) : null }, { gitBin: git.bin() });
  });
  h('ssh:use', (o) => exclusive('切換 SSH 金鑰', () => useKey(o)));
  h('ssh:reveal', () => {
    const dir = S.sshDir();
    if (!fs.existsSync(dir)) throw new Error('還沒有 ~/.ssh 資料夾，產生金鑰後就會建立');
    return ctx.shell.openPath(dir);
  });

  /* 專案交換 */
  h('openIn', ({ id, ...o }) => openIn(id, o));
  h('shareFile', ({ id }) => shareFile(id));
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
  ex('setRemoteUrl', '變更遠端網址', ({ id, ...o }) => ops.setRemoteUrl(git, top(id), o));
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
    ctx.commands.register('gitTool.sshKeys', () => toView('sshKeys')),
    ctx.settings.onDidChange((key) => ctx.ui.emit('settingsChanged', { key, settings: ctx.settings.all() })),
    { dispose: () => { unwatch(); if (running && running.cancel) running.cancel(); } },
  );
};

/** contributes.exchange.imports 的 handler：接收 git-tool.project */
exports.importProject = (context, pkg, info) => {
  if (!ctx) { ctx = context; git = G.createRunner({ gitPath: () => setting('gitPath', ''), onLog }); }
  return importProject(pkg, info);
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
exports._internal = { addRepo, renameRepo, removeRepo, exclusive, sshState, useKey, importProject, projectPayload, shareFile, takePending: () => { const c = pendingCommand; pendingCommand = null; return c; }, setContext: (c) => { ctx = c; git = G.createRunner({ onLog }); } };
