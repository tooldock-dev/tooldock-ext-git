'use strict';
/* 在暫存資料夾建立真的 Git 儲存庫（含本機的「遠端」bare 儲存庫），實際執行每一項操作。需要安裝 git。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../backend/git');
const ops = require('../backend/ops');
const C = require('../ui/git-core');

const logs = [];
const git = G.createRunner({ onLog: (e) => logs.push(e) });
// 測試不受使用者全域設定影響
const ENV = {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
};
Object.assign(process.env, ENV);

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-test-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** 建立 bare 遠端與一個有初始提交的工作儲存庫 */
async function setup(dir) {
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(remote);
  fs.mkdirSync(work);
  await git(['init', '--bare', '-q', '-b', 'main'], remote);
  await git(['init', '-q', '-b', 'main'], work);
  await git(['remote', 'add', 'origin', remote], work);
  write(work, 'a.txt', 'line1\nline2\nline3\n');
  await ops.stage(git, work, ['a.txt']);
  await ops.commit(git, work, { message: '初始提交' });
  return { remote, work };
}

test('參數檢查：路徑不能跳出儲存庫、名稱不能以 - 開頭、網址', () => {
  assert.equal(G.safeRel('/r', 'a/b.txt'), 'a/b.txt');
  assert.throws(() => G.safeRel('/r', '../x'), /不在儲存庫/);
  assert.throws(() => G.safeRel('/r', '.git/config'), /\.git/);
  assert.throws(() => G.safeRef('--upload-pack=x'), /不正確/);
  assert.throws(() => ops.checkUrl('ext::sh -c x'), /不正確|不支援/);
  assert.throws(() => ops.checkUrl('-u'), /不正確/);
  assert.equal(ops.repoNameFromUrl('https://github.com/a/b.git'), 'b');
  assert.equal(ops.repoNameFromUrl('git@github.com:a/my-repo.git'), 'my-repo');
  assert.equal(ops.repoNameFromUrl('/local/path/repo/'), 'repo');
});

test('錯誤說明', () => {
  assert.equal(G.explain('fatal: could not read Username for \'https://github.com\': terminal prompts disabled').code, 'AUTH');
  assert.equal(G.explain(' ! [rejected]        main -> main (fetch first)\nerror: failed to push').code, 'REJECTED');
  assert.equal(G.explain('*** Please tell me who you are.').code, 'NO_IDENTITY');
  const e = G.explain('hint: x\nfatal: something odd\n');
  assert.equal(e.code, 'GIT_FAILED');
  assert.equal(e.message, 'something odd');
});

test('解析：status、log 裝飾、name-status、remote', () => {
  const st = G.parseStatus(Buffer.from('## main...origin/main [ahead 2, behind 1]\0M  a.txt\0 M b.txt\0R  new.txt\0old.txt\0UU c.txt\0?? d.txt\0'));
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.equal(st.ahead, 2);
  assert.equal(st.behind, 1);
  const g = G.group(st.entries);
  assert.deepEqual(g.staged.map((e) => e.path), ['a.txt', 'new.txt']);
  assert.equal(g.staged[1].orig, 'old.txt');
  assert.deepEqual(g.unstaged.map((e) => e.path), ['b.txt']);
  assert.deepEqual(g.conflict.map((e) => e.xy), ['UU']);
  assert.deepEqual(g.untracked.map((e) => e.path), ['d.txt']);

  const refs = G.parseRefs('HEAD -> refs/heads/feature/x, refs/remotes/origin/feature/x, refs/remotes/origin/HEAD, tag: refs/tags/v1.0');
  assert.deepEqual(refs, [
    { type: 'local', name: 'feature/x', head: true },
    { type: 'remote', name: 'origin/feature/x' },
    { type: 'tag', name: 'v1.0' },
  ]);
  assert.deepEqual(G.parseNameStatus('M\0a\0R087\0o\0n\0'), [
    { status: 'M', path: 'a', label: '修改' },
    { status: 'R', orig: 'o', path: 'n', score: 87, label: '重新命名' },
  ]);
  assert.deepEqual(G.parseRemotes('origin\thttps://x/y.git (fetch)\norigin\thttps://x/y.git (push)\n'), [{ name: 'origin', url: 'https://x/y.git', pushUrl: 'https://x/y.git' }]);
});

test('工作區：暫存、取消暫存、捨棄、提交、比對', () => withTmp(async (dir) => {
  const { work } = await setup(dir);
  write(work, 'a.txt', 'line1\nCHANGED\nline3\n');
  write(work, 'new.txt', 'hello\n');
  write(work, 'trash.txt', 'x\n');
  let st = await ops.status(git, work);
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.unstaged.map((e) => e.path), ['a.txt']);
  assert.deepEqual(st.untracked.map((e) => e.path).sort(), ['new.txt', 'trash.txt']);

  const d = await ops.diffSides(git, work, { area: 'unstaged', path: 'a.txt' });
  assert.equal(d.left.text, 'line1\nline2\nline3\n');
  assert.equal(d.right.text, 'line1\nCHANGED\nline3\n');

  await ops.discard(git, work, { untracked: ['trash.txt'] });
  assert.equal(fs.existsSync(path.join(work, 'trash.txt')), false);

  await ops.stage(git, work, ['a.txt', 'new.txt']);
  st = await ops.status(git, work);
  assert.deepEqual(st.staged.map((e) => e.path).sort(), ['a.txt', 'new.txt']);
  await ops.unstage(git, work, ['new.txt']);
  st = await ops.status(git, work);
  assert.deepEqual(st.staged.map((e) => e.path), ['a.txt']);

  await assert.rejects(ops.commit(git, work, { message: '  ' }), /提交訊息/);
  const head = await ops.commit(git, work, { message: '修改 a\n\n詳細說明' });
  assert.match(head, /修改 a/);
  const info = await ops.commitInfo(git, work, (await ops.status(git, work)).head.hash);
  assert.equal(info.message, '修改 a\n\n詳細說明');
  assert.deepEqual(info.files.map((f) => f.path), ['a.txt']);
  const cd = await ops.commitDiff(git, work, { hash: info.hash, parent: info.parents[0], path: 'a.txt' });
  assert.equal(cd.right.text, 'line1\nCHANGED\nline3\n');

  // 修正上一次提交
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: '', amend: true });
  const after = await ops.commitInfo(git, work, (await ops.status(git, work)).head.hash);
  assert.deepEqual(after.files.map((f) => f.path).sort(), ['a.txt', 'new.txt']);

  // 捨棄已追蹤檔案的變更
  write(work, 'a.txt', 'oops\n');
  await ops.discard(git, work, { tracked: ['a.txt'] });
  assert.equal(read(work, 'a.txt'), 'line1\nCHANGED\nline3\n');
}));

test('還沒有提交的儲存庫：狀態、線圖、取消暫存', () => withTmp(async (dir) => {
  await ops.init(git, dir);
  write(dir, 'x.txt', 'x\n');
  await ops.stage(git, dir, ['x.txt']);
  let st = await ops.status(git, dir);
  assert.equal(st.noCommits, true);
  assert.equal(st.staged.length, 1);
  assert.deepEqual(await ops.log(git, dir), { commits: [], more: false });
  await ops.unstage(git, dir, ['x.txt'], { noCommits: true });
  st = await ops.status(git, dir);
  assert.equal(st.staged.length, 0);
  assert.equal(st.untracked.length, 1);
}));

test('遠端：推送（建立追蹤）、複製、拉取、被拒絕、擷取', () => withTmp(async (dir) => {
  const { remote, work } = await setup(dir);
  const progress = [];
  const net = { timeout: 30000, onProgress: (t) => progress.push(t) };
  let r = await ops.push(git, work, {}, net);
  assert.equal(r.created, true);
  assert.equal((await ops.status(git, work)).upstream, 'origin/main');

  const dest = await ops.clone(git, { url: remote, parent: dir }, net);
  assert.equal(dest, path.join(dir, 'remote'));
  assert.equal(read(dest, 'a.txt'), 'line1\nline2\nline3\n');
  await assert.rejects(ops.clone(git, { url: remote, parent: dir }, net), /不是空的/);

  // 另一邊推送新提交
  write(dest, 'b.txt', 'b\n');
  await ops.stageAll(git, dest);
  await ops.commit(git, dest, { message: '新增 b' });
  r = await ops.push(git, dest, {}, net);
  assert.equal(r.created, false);

  // 本機也有新提交 → 推送被拒絕
  write(work, 'c.txt', 'c\n');
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: '新增 c' });
  await assert.rejects(ops.push(git, work, {}, net), (e) => e.code === 'REJECTED');

  await ops.fetchAll(git, work, net);
  let st = await ops.status(git, work);
  assert.equal(st.ahead, 1);
  assert.equal(st.behind, 1);

  // 合併方式拉取後可以推送
  r = await ops.pull(git, work, { mode: 'merge' }, net);
  assert.equal(r.conflict, false);
  assert.equal(read(work, 'b.txt'), 'b\n');
  await ops.push(git, work, {}, net);
  st = await ops.status(git, work);
  assert.equal(st.ahead, 0);

  // 線圖：最新的是合併提交，有兩條線
  const { commits } = await ops.log(git, work);
  assert.equal(commits[0].parents.length, 2);
  assert.ok(commits[0].refs.some((x) => x.type === 'local' && x.name === 'main' && x.head));
  assert.ok(commits[0].refs.some((x) => x.type === 'remote' && x.name === 'origin/main'));
  const g = C.layoutGraph(commits);
  assert.equal(g.width, 2);
}));

test('分支：建立、切換、遠端分支、合併衝突、逐段解決、完成合併', () => withTmp(async (dir) => {
  const { work } = await setup(dir);
  await ops.createBranch(git, work, { name: 'feature/x' });
  assert.equal((await ops.status(git, work)).branch, 'feature/x');
  await assert.rejects(ops.createBranch(git, work, { name: 'bad name' }), /不合法/);
  write(work, 'a.txt', 'line1\nFEATURE\nline3\n');
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: 'feature 修改' });

  await ops.checkout(git, work, { branch: 'main' });
  write(work, 'a.txt', 'line1\nMAIN\nline3\n');
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: 'main 修改' });

  const br = await ops.branches(git, work);
  assert.deepEqual(br.local.map((b) => b.name).sort(), ['feature/x', 'main']);
  assert.equal(br.local.find((b) => b.current).name, 'main');

  // 未合併的分支不能直接刪除
  await assert.rejects(ops.deleteBranch(git, work, { name: 'feature/x' }), (e) => e.code === 'NOT_MERGED');

  const m = await ops.merge(git, work, { ref: 'feature/x' });
  assert.equal(m.conflict, true);
  assert.deepEqual(m.files, ['a.txt']);
  let st = await ops.status(git, work);
  assert.equal(st.state, 'merge');
  assert.match(st.mergeMessage, /Merge branch 'feature\/x'/);

  const info = await ops.conflictInfo(git, work, { path: 'a.txt' });
  assert.equal(info.xy, 'UU');
  assert.equal(info.ours && info.theirs && info.base, true);
  const segs = C.parseConflicts(info.working.text);
  const cs = segs.filter((s) => s.type === 'conflict');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].ours, 'MAIN\n');
  assert.equal(cs[0].theirs, 'FEATURE\n');

  await assert.rejects(ops.continueOp(git, work), /沒有解決/);
  await ops.resolveText(git, work, { path: 'a.txt', text: C.resolveConflicts(segs, { 0: 'both' }) });
  assert.equal(read(work, 'a.txt'), 'line1\nMAIN\nFEATURE\nline3\n');
  st = await ops.status(git, work);
  assert.equal(st.conflict.length, 0);
  await ops.continueOp(git, work);
  st = await ops.status(git, work);
  assert.equal(st.state, '');
  const { commits } = await ops.log(git, work);
  assert.equal(commits[0].parents.length, 2);
  assert.match(commits[0].subject, /Merge branch 'feature\/x'/);

  // 合併後可以刪除
  await ops.deleteBranch(git, work, { name: 'feature/x' });
  // 標籤
  await ops.createTag(git, work, { name: 'v1.0', message: '第一版' });
  assert.deepEqual((await ops.branches(git, work)).tags.map((t) => t.name), ['v1.0']);
  await ops.deleteTag(git, work, { name: 'v1.0' });
}));

test('衝突：整個檔案採用一方、中止合併、切換遠端分支', () => withTmp(async (dir) => {
  const { remote, work } = await setup(dir);
  await ops.push(git, work, {}, {});
  await ops.createBranch(git, work, { name: 'dev' });
  write(work, 'a.txt', 'dev\n');
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: 'dev' });
  await ops.push(git, work, {}, {});
  await ops.checkout(git, work, { branch: 'main' });
  write(work, 'a.txt', 'main\n');
  await ops.stageAll(git, work);
  await ops.commit(git, work, { message: 'main' });

  assert.equal((await ops.merge(git, work, { ref: 'dev' })).conflict, true);
  await ops.abortOp(git, work);
  assert.equal((await ops.status(git, work)).state, '');
  assert.equal(read(work, 'a.txt'), 'main\n');

  assert.equal((await ops.merge(git, work, { ref: 'dev' })).conflict, true);
  await ops.takeSide(git, work, { path: 'a.txt', side: 'theirs' });
  assert.equal(read(work, 'a.txt'), 'dev\n');
  await ops.continueOp(git, work);

  // 從另一個複本切換遠端分支：建立追蹤的本機分支
  const other = await ops.clone(git, { url: remote, parent: dir, name: 'other' }, {});
  const local = await ops.checkout(git, other, { remote: 'origin/dev' });
  assert.equal(local, 'dev');
  const st = await ops.status(git, other);
  assert.equal(st.branch, 'dev');
  assert.equal(st.upstream, 'origin/dev');
}));

test('儲藏：儲藏、列表、內容、套用、刪除', () => withTmp(async (dir) => {
  const { work } = await setup(dir);
  await assert.rejects(ops.stashPush(git, work, {}), /沒有可以儲藏/);
  write(work, 'a.txt', 'stashed\n');
  write(work, 'u.txt', 'untracked\n');
  await ops.stashPush(git, work, { message: '暫時放著' });
  let st = await ops.status(git, work);
  assert.equal(st.unstaged.length + st.untracked.length, 0);
  const list = await ops.stashes(git, work);
  assert.equal(list.length, 1);
  assert.equal(list[0].ref, 'stash@{0}');
  assert.match(list[0].subject, /暫時放著/);
  const files = await ops.stashFiles(git, work, { ref: 'stash@{0}' });
  assert.ok(files.files.some((f) => f.path === 'a.txt'));
  assert.ok(files.untrackedHash);
  await ops.stashApply(git, work, { ref: 'stash@{0}' });
  assert.equal(read(work, 'u.txt'), 'untracked\n');
  await ops.stashDrop(git, work, { ref: 'stash@{0}' });
  assert.equal((await ops.stashes(git, work)).length, 0);
  await assert.rejects(ops.stashDrop(git, work, { ref: 'stash@{0}; rm' }), /不正確/);
  st = await ops.status(git, work);
  assert.equal(st.unstaged.length, 1);
}));

test('身分：沒有設定時提交失敗並回報 NO_IDENTITY；設定在儲存庫後可以提交', () => withTmp(async (dir) => {
  const { work } = await setup(dir);
  const saved = {};
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) { saved[k] = process.env[k]; delete process.env[k]; }
  const savedEmail = process.env.EMAIL;
  delete process.env.EMAIL;
  try {
    await git(['config', 'user.useConfigOnly', 'true'], work);
    write(work, 'n.txt', 'n\n');
    await ops.stageAll(git, work);
    await assert.rejects(ops.commit(git, work, { message: 'x' }), (e) => e.code === 'NO_IDENTITY');
    await ops.setIdentity(git, work, { name: '王小明', email: 'ming@example.com', global: false });
    assert.deepEqual(await ops.identity(git, work), { name: '王小明', email: 'ming@example.com' });
    await ops.commit(git, work, { message: 'x' });
  } finally {
    Object.assign(process.env, saved);
    if (savedEmail !== undefined) process.env.EMAIL = savedEmail;
  }
}));

test('網路操作可以取消', () => withTmp(async (dir) => {
  // 用一個不會回應的「git」來模擬卡住的網路操作
  const fake = path.join(dir, process.platform === 'win32' ? 'fake.cmd' : 'fake.sh');
  fs.writeFileSync(fake, process.platform === 'win32' ? '@ping -n 30 127.0.0.1 > nul\r\n' : '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(fake, 0o755);
  if (process.platform === 'win32') return; // .cmd 需要經過 shell，這裡只在 macOS／Linux 驗證
  const slow = G.createRunner({ gitPath: () => fake });
  let cancel = null;
  const p = slow(['fetch'], dir, { onSpawn: (c) => { cancel = c; } });
  setTimeout(() => cancel(), 100);
  await assert.rejects(p, (e) => e.code === 'CANCELED');
  await assert.rejects(slow(['fetch'], dir, { timeout: 150 }), (e) => e.code === 'TIMEOUT');
}));

test('輸出紀錄：每個指令都有紀錄，失敗時含錯誤', () => {
  assert.ok(logs.some((l) => l.args[0] === 'commit' && l.ok));
  assert.ok(logs.some((l) => !l.ok && l.message));
});
