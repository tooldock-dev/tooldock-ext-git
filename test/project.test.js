'use strict';
/* 專案交換 git-tool.project：格式驗證，以及後端的匯入、分享（用假的 ctx，實際執行 git）。需要安裝 git。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../backend/project');
const G = require('../backend/git');
const backend = require('../backend/index');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
});
const git = G.createRunner({});

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-proj-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** 最小的 ExtensionContext：storage 在記憶體、記錄畫面事件、exchange.create 照平台的方式包信封 */
function fakeCtx({ savePath = null } = {}) {
  const data = new Map();
  const events = [];
  const ctx = {
    events,
    storage: {
      get: (k, d) => (data.has(k) ? data.get(k) : d),
      set: (k, v) => data.set(k, v),
      delete: (k) => data.delete(k),
      keys: () => [...data.keys()],
    },
    settings: { get: (k, d) => d, all: () => ({}) },
    ui: { emit: (event, payload) => events.push({ event, payload }) },
    log: { info() {}, warn() {}, error() {} },
    exchange: {
      create: (type, payload, meta) => ({ format: 'tooldock.exchange/1', id: 'x1', type, typeVersion: 1, title: meta.title, description: meta.description, source: { extId: 'git-tool', version: '1.1.0', platform: 'test' }, createdAt: new Date().toISOString(), payload }),
    },
    toasts: [],
    window: { toast: async (m) => { ctx.toasts.push(m); return true; }, showSaveDialog: async () => (savePath ? { canceled: false, filePath: savePath } : { canceled: true }) },
  };
  return ctx;
}

async function repoAt(dir, remoteUrl) {
  fs.mkdirSync(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], dir);
  if (remoteUrl) await git(['remote', 'add', 'origin', remoteUrl], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await git(['add', 'a.txt'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

test('網址：去掉帳號密碼，只接受網路上的遠端', () => {
  assert.equal(P.stripCredentials('https://user:ghp_token@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(P.stripCredentials('https://ghp_token@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(P.stripCredentials('ssh://git:pw@host.com/a.git'), 'ssh://git@host.com/a.git');
  assert.equal(P.stripCredentials('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  for (const u of ['https://github.com/a/b.git', 'http://h.local/x', 'ssh://git@h.com:22/x.git', 'git://h.com/x', 'git@github.com:a/b.git', 'host.example.com:repo.git']) {
    assert.ok(P.isNetworkUrl(u), u);
  }
  for (const u of ['/srv/repo.git', 'C:\\repo', 'C:/repo', 'file:///srv/repo.git', 'ext::sh -c touch% /tmp/x', '-uhack', '../x', 'https://h.com/a b', '']) {
    assert.ok(!P.isNetworkUrl(u), u);
  }
  assert.ok(P.sameRemote('https://github.com/A/b.git', 'git@github.com:A/b'));
  assert.ok(P.sameRemote('https://tok@GitHub.com/a/b/', 'https://github.com/a/b.git'));
  assert.ok(!P.sameRemote('https://github.com/a/b.git', 'https://github.com/a/c.git'));
});

test('建立 payload：分享給別人時不帶路徑與帳密，沒有遠端時拒絕', () => {
  const remotes = [{ name: 'upstream', url: 'https://github.com/o/x.git' }, { name: 'origin', url: 'https://me:tok@github.com/me/x.git' }, { name: 'local', url: '/srv/x.git' }];
  const local = P.buildPayload({ name: 'x', root: '/w/x', remotes, branch: 'dev', file: 'src/a.js', line: 3 });
  assert.equal(local.path, path.resolve('/w/x'));
  assert.deepEqual(local.remotes, [{ name: 'origin', url: 'https://github.com/me/x.git' }, { name: 'upstream', url: 'https://github.com/o/x.git' }]);
  assert.equal(local.file, 'src/a.js');
  assert.equal(local.line, 3);
  const shared = P.buildPayload({ name: 'x', root: '/w/x', remotes, branch: 'dev', file: 'src/a.js' }, { forFile: true });
  assert.equal(shared.path, undefined);
  assert.equal(shared.file, undefined);
  assert.equal(shared.branch, 'dev');
  assert.ok(!JSON.stringify(shared).includes('tok'));
  assert.throws(() => P.buildPayload({ name: 'x', root: '/w/x', remotes: [{ name: 'origin', url: '/srv/x.git' }] }, { forFile: true }), (e) => e.code === 'NO_REMOTE');
});

test('解析 payload：從檔案匯入時忽略路徑，檔案不能跳出專案，分支名稱要合法', () => {
  const abs = path.resolve('/w/x');
  const p = P.parsePayload({ name: 'x', path: abs, file: 'src/a.js', line: 2, branch: 'feature/a' });
  assert.equal(p.path, abs);
  assert.equal(p.file, 'src/a.js');
  assert.equal(p.line, 2);
  assert.equal(p.branch, 'feature/a');
  assert.equal(P.parsePayload({ path: abs, file: '../../etc/passwd' }).file, null);
  assert.equal(P.parsePayload({ path: abs, branch: '--upload-pack=x' }).branch, null);
  assert.equal(P.parsePayload({ path: abs, branch: 'a..b' }).branch, null);
  assert.equal(P.parsePayload({ path: abs }).name, 'x');
  assert.throws(() => P.parsePayload({ path: 'relative/x' }), /絕對路徑/);
  assert.throws(() => P.parsePayload(null), /不正確/);
  // 從 .tdx 檔：路徑被忽略，只剩遠端；危險的網址被濾掉
  assert.throws(() => P.parsePayload({ path: abs }, { origin: 'file' }), /遠端網址/);
  assert.throws(() => P.parsePayload({ remotes: [{ name: 'origin', url: 'ext::sh -c x' }] }, { origin: 'file' }), /遠端網址/);
  const f = P.parsePayload({ path: abs, remotes: [{ name: 'origin', url: 'https://t@github.com/a/proj.git' }] }, { origin: 'file' });
  assert.equal(f.path, null);
  assert.deepEqual(f.remotes, [{ name: 'origin', url: 'https://github.com/a/proj.git' }]);
  assert.equal(f.name, 'proj');
});

test('匯入：本機路徑加入清單並選取；子資料夾找到儲存庫根目錄；不是儲存庫時交給畫面詢問', () => withTmp(async (dir) => {
  const ctx = fakeCtx();
  backend._internal.setContext(ctx);
  const work = await repoAt(path.join(dir, 'work'));
  fs.mkdirSync(path.join(work, 'sub'));

  const r1 = await backend._internal.importProject({ payload: { name: '我的專案', path: work } }, { origin: 'share', producer: { extId: 'code-editor', name: '程式碼編輯器' } });
  assert.equal(r1.status, 'imported');
  assert.equal(r1.data.added, true);
  const repos = ctx.storage.get('repos');
  assert.equal(repos.length, 1);
  assert.equal(repos[0].name, '我的專案');
  assert.equal(ctx.storage.get('lastRepo'), repos[0].id);
  assert.deepEqual(backend._internal.takePending(), { command: 'openRepo', id: repos[0].id });
  assert.equal(ctx.events.at(-1).event, 'command');

  // 子資料夾：同一個儲存庫，不重複加入
  const r2 = await backend._internal.importProject({ payload: { name: 'sub', path: path.join(work, 'sub') } }, { origin: 'share' });
  assert.equal(r2.data.added, false);
  assert.equal(ctx.storage.get('repos').length, 1);

  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  const r3 = await backend._internal.importProject({ payload: { path: plain } }, { origin: 'share' });
  assert.equal(r3.status, 'imported');
  assert.deepEqual(backend._internal.takePending(), { command: 'addRepo', dir: plain });

  const r4 = await backend._internal.importProject({ payload: { path: path.join(dir, 'gone') } }, { origin: 'share' });
  assert.equal(r4.status, 'rejected');
  const r5 = await backend._internal.importProject({ payload: 'x' }, { origin: 'share' });
  assert.equal(r5.status, 'rejected');
  assert.deepEqual(ctx.toasts, [r4.message, r5.message], '拒絕時要用 toast 告訴使用者');
}));

test('匯入：從交換檔只開啟複製畫面，清單中已有相同遠端時一併告知', () => withTmp(async (dir) => {
  const ctx = fakeCtx();
  backend._internal.setContext(ctx);
  const work = await repoAt(path.join(dir, 'work'), 'git@github.com:team/app.git');
  await backend._internal.addRepo(work);

  const pkg = { payload: { name: 'app', path: work, remotes: [{ name: 'origin', url: 'https://github.com/team/app.git' }], branch: 'main' } };
  const r = await backend._internal.importProject(pkg, { origin: 'file' });
  assert.equal(r.status, 'imported');
  const c = backend._internal.takePending();
  assert.equal(c.command, 'cloneProject');
  assert.equal(c.origin, 'file');
  assert.deepEqual(c.project, { name: 'app', remotes: [{ name: 'origin', url: 'https://github.com/team/app.git' }], branch: 'main' });
  assert.equal(c.existing.length, 1);
  assert.equal(c.existing[0].root, work);
  // 沒有任何本機檔案被建立
  assert.deepEqual(fs.readdirSync(dir).sort(), ['work']);

  const other = await backend._internal.importProject({ payload: { remotes: [{ name: 'origin', url: 'https://github.com/team/other.git' }] } }, { origin: 'file' });
  assert.equal(other.status, 'imported');
  assert.deepEqual(backend._internal.takePending().existing, []);
}));

test('分享：存成 .tdx 只含遠端與分支；沒有網路遠端時回報 NO_REMOTE', () => withTmp(async (dir) => {
  const out = path.join(dir, 'share');
  const ctx = fakeCtx({ savePath: out });
  backend._internal.setContext(ctx);
  const work = await repoAt(path.join(dir, 'work'), 'https://me:secret@github.com/me/app.git');
  const { repo } = await backend._internal.addRepo(work);

  const r = await backend._internal.shareFile(repo.id);
  assert.equal(r.filePath, `${out}.tdx`);
  const pkg = JSON.parse(fs.readFileSync(r.filePath, 'utf8'));
  assert.equal(pkg.type, 'git-tool.project');
  assert.deepEqual(pkg.payload, { name: 'work', remotes: [{ name: 'origin', url: 'https://github.com/me/app.git' }], branch: 'main' });
  assert.ok(!fs.readFileSync(r.filePath, 'utf8').includes('secret'));
  assert.ok(!fs.readFileSync(r.filePath, 'utf8').includes(work));

  // 收到自己分享的檔案：會找到同一個儲存庫
  await backend._internal.importProject(pkg, { origin: 'file' });
  assert.equal(backend._internal.takePending().existing[0].id, repo.id);

  const bare = await repoAt(path.join(dir, 'bare-remote'), path.join(dir, 'x.git'));
  const { repo: r2 } = await backend._internal.addRepo(bare);
  await assert.rejects(backend._internal.shareFile(r2.id), (e) => e.code === 'NO_REMOTE');

  // 給同一台電腦的其他工具：帶路徑與檔案
  const local = await backend._internal.projectPayload(repo.id, { file: 'a.txt', line: 1 });
  assert.equal(local.path, work);
  assert.equal(local.file, 'a.txt');
}));

test('複製時可以指定分支', () => withTmp(async (dir) => {
  const ops = require('../backend/ops');
  const src = await repoAt(path.join(dir, 'src'));
  await git(['branch', 'dev'], src);
  const dest = await ops.clone(git, { url: src, parent: dir, name: 'copy', branch: 'dev' }, {});
  assert.equal((await git.text(['symbolic-ref', '--short', 'HEAD'], dest)).trim(), 'dev');
  await assert.rejects(ops.clone(git, { url: src, parent: dir, name: 'copy2', branch: '-x' }, {}), /不正確/);
}));
