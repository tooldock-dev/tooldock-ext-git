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
  assert.equal(G.explain('error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.').code, 'DIRTY');
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

const check = (d) => `${C.textHash(d.left.text)}:${C.textHash(d.right.text)}`;
const show = async (dir, spec) => (await git.text(['show', spec], dir, { quiet: true }));

test('逐行暫存：暫存、取消暫存、捨棄一部分的行，保留 CRLF 與執行權限', async () => {
  await withTmp(async (dir) => {
    const { work } = await setup(dir);
    // a.txt：line1 line2 line3 → 改 line1、在最後加 line4
    write(work, 'a.txt', 'LINE1\nline2\nline3\nline4\n');
    let d = await ops.diffSides(git, work, { area: 'unstaged', path: 'a.txt' });
    // 只暫存新增的 line4（右側第 3 行）
    await ops.partial(git, work, { area: 'unstaged', action: 'stage', path: 'a.txt', add: [3], check: check(d) });
    assert.equal(await show(work, ':a.txt'), 'line1\nline2\nline3\nline4\n');
    let s = await ops.status(git, work);
    assert.equal(s.staged.length, 1);
    assert.equal(s.unstaged.length, 1);
    // 內容改變後舊的雜湊被拒絕
    await assert.rejects(ops.partial(git, work, { area: 'unstaged', action: 'stage', path: 'a.txt', add: [0], check: check(d) }), /修改過/);
    // 取消暫存 line4
    d = await ops.diffSides(git, work, { area: 'staged', path: 'a.txt' });
    await ops.partial(git, work, { area: 'staged', action: 'unstage', path: 'a.txt', add: [3], check: check(d) });
    s = await ops.status(git, work);
    assert.equal(s.staged.length, 0);
    // 捨棄 LINE1 的修改（左 0 刪除、右 0 新增），保留 line4
    d = await ops.diffSides(git, work, { area: 'unstaged', path: 'a.txt' });
    await ops.partial(git, work, { area: 'unstaged', action: 'discard', path: 'a.txt', del: [0], add: [0], check: check(d) });
    assert.equal(read(work, 'a.txt'), 'line1\nline2\nline3\nline4\n');
    // 選取全部變更時改用整個檔案暫存
    d = await ops.diffSides(git, work, { area: 'unstaged', path: 'a.txt' });
    const r = await ops.partial(git, work, { area: 'unstaged', action: 'stage', path: 'a.txt', add: [3], check: check(d) });
    assert.equal(r.whole, true);

    // CRLF 檔案與執行權限
    write(work, 'run.sh', 'echo 1\r\necho 2\r\n');
    fs.chmodSync(path.join(work, 'run.sh'), 0o755);
    await ops.stage(git, work, ['run.sh']);
    await ops.commit(git, work, { message: 'run' });
    write(work, 'run.sh', 'echo 0\r\necho 1\r\necho 2\r\necho 3\r\n');
    d = await ops.diffSides(git, work, { area: 'unstaged', path: 'run.sh' });
    await ops.partial(git, work, { area: 'unstaged', action: 'stage', path: 'run.sh', add: [3], check: check(d) });
    assert.equal(await show(work, ':run.sh'), 'echo 1\r\necho 2\r\necho 3\r\n');
    if (process.platform !== 'win32') assert.match(await git.text(['ls-files', '-s', 'run.sh'], work), /^100755 /);

    // 未追蹤的檔案只暫存一部分
    write(work, 'new.txt', 'n1\nn2\n');
    d = await ops.diffSides(git, work, { area: 'untracked', path: 'new.txt' });
    await ops.partial(git, work, { area: 'untracked', action: 'stage', path: 'new.txt', add: [0], check: check(d) });
    assert.equal(await show(work, ':new.txt'), 'n1\n');
    // 只有 BOM 的檔案保留 BOM
    write(work, 'bom.txt', '﻿b1\n');
    await ops.stage(git, work, ['bom.txt']);
    write(work, 'bom.txt', '﻿b1\nb2\n');
    d = await ops.diffSides(git, work, { area: 'unstaged', path: 'bom.txt' });
    assert.equal(d.right.bom, true);
    await ops.partial(git, work, { area: 'unstaged', action: 'stage', path: 'bom.txt', add: [1], check: check(d) });
    assert.equal(await show(work, ':bom.txt'), '﻿b1\nb2\n');
  });
});

test('標籤：推送單一標籤、推送全部、刪除遠端標籤；推送時一併推送標籤', async () => {
  await withTmp(async (dir) => {
    const { remote, work } = await setup(dir);
    await ops.push(git, work, {});
    await ops.createTag(git, work, { name: 'v1' });
    await ops.createTag(git, work, { name: 'v2', message: '第二版' });
    const remoteTags = async () => (await git.text(['tag', '-l'], remote)).split('\n').filter(Boolean);
    await ops.pushTag(git, work, { name: 'v1' });
    assert.deepEqual(await remoteTags(), ['v1']);
    await ops.pushTag(git, work, {});
    assert.deepEqual(await remoteTags(), ['v1', 'v2']);
    await ops.deleteRemoteTag(git, work, { name: 'v1' });
    assert.deepEqual(await remoteTags(), ['v2']);
    await assert.rejects(ops.pushTag(git, work, { name: '-x' }), /不正確/);
    await ops.createTag(git, work, { name: 'v3' });
    write(work, 'a.txt', 'changed\n');
    await ops.stageAll(git, work);
    await ops.commit(git, work, { message: '第二個提交' });
    const r = await ops.push(git, work, { tags: true });
    assert.equal(r.tags, true);
    assert.deepEqual(await remoteTags(), ['v1', 'v2', 'v3']);
  });
});

test('提交選項、儲藏選取的檔案、加入 .gitignore、存成 patch、與工作目錄比較', async () => {
  await withTmp(async (dir) => {
    const { work } = await setup(dir);
    fs.mkdirSync(path.join(work, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    write(work, 'b.txt', 'b\n');
    await ops.stage(git, work, ['b.txt']);
    if (process.platform !== 'win32') await assert.rejects(ops.commit(git, work, { message: '被 hook 擋下' }));
    await ops.commit(git, work, { message: '略過 hook', noVerify: true, signoff: true });
    assert.match(await git.text(['log', '-1', '--format=%B'], work), /Signed-off-by: Tester <t@example.com>/);

    write(work, 'a.txt', 'A\n');
    write(work, 'c.txt', 'c\n');
    await ops.stashPush(git, work, { paths: ['a.txt'], message: '只有 a' });
    let s = await ops.status(git, work);
    assert.deepEqual(s.unstaged.map((e) => e.path), []);
    assert.deepEqual(s.untracked.map((e) => e.path), ['c.txt']);

    assert.equal(ops.addIgnore(work, { pattern: '*.log' }).added, true);
    assert.equal(ops.addIgnore(work, { pattern: '*.log' }).added, false);
    assert.equal(read(work, '.gitignore'), '*.log\n');
    assert.throws(() => ops.addIgnore(work, { pattern: 'a\nb' }), /不正確/);

    const head = (await git.text(['rev-parse', 'HEAD'], work)).trim();
    const patch = (await ops.formatPatch(git, work, { hash: head })).toString('utf8');
    assert.match(patch, /^From [0-9a-f]+/);
    assert.match(patch, /b\.txt/);

    write(work, 'b.txt', 'b2\n');
    const files = await ops.compareWorking(git, work, { hash: head });
    assert.deepEqual(files.map((f) => f.path), ['b.txt']);
    const d = await ops.compareWorkingDiff(git, work, { hash: head, path: 'b.txt' });
    assert.equal(d.left.text, 'b\n');
    assert.equal(d.right.text, 'b2\n');
  });
});

test('重定基底：rebase onto、互動式（重新排序、squash、fixup、reword、drop）、修改舊提交的訊息', async () => {
  await withTmp(async (dir) => {
    const { work } = await setup(dir);
    const base = (await git.text(['rev-parse', 'HEAD'], work)).trim();
    for (const n of ['one', 'two', 'three', 'four']) {
      write(work, `${n}.txt`, `${n}\n`);
      await ops.stage(git, work, [`${n}.txt`]);
      await ops.commit(git, work, { message: `add ${n}` });
    }
    const list = await ops.rebaseList(git, work, { base });
    assert.deepEqual(list.map((c) => c.subject), ['add one', 'add two', 'add three', 'add four']);
    const [one, two, three, four] = list;
    await assert.rejects(ops.interactiveRebase(git, work, { base, steps: [{ hash: two.hash, action: 'fixup' }, { hash: one.hash, action: 'pick' }, { hash: three.hash, action: 'pick' }, { hash: four.hash, action: 'pick' }] }), /第一個/);
    const r = await ops.interactiveRebase(git, work, { base, steps: [
      { hash: three.hash, action: 'reword', message: '三（改過的訊息）' },
      { hash: one.hash, action: 'pick' },
      { hash: two.hash, action: 'fixup' },
      { hash: four.hash, action: 'drop' },
    ] });
    assert.equal(r.conflict, false);
    const subjects = (await git.text(['log', '--format=%s', `${base}..HEAD`], work)).trim().split('\n');
    assert.deepEqual(subjects, ['add one', '三（改過的訊息）']);
    assert.ok(!fs.existsSync(path.join(work, 'four.txt')));
    assert.ok(fs.existsSync(path.join(work, 'two.txt')));
    // squash 並指定合併後的訊息
    const l2 = await ops.rebaseList(git, work, { base });
    await ops.interactiveRebase(git, work, { base, steps: [{ hash: l2[0].hash, action: 'pick' }, { hash: l2[1].hash, action: 'squash', message: '合併：一二三' }] });
    assert.equal((await git.text(['log', '--format=%s', `${base}..HEAD`], work)).trim(), '合併：一二三');
    // 修改 HEAD 與較早提交的訊息；HEAD 修改時不帶入暫存的變更
    write(work, 'x.txt', 'x\n');
    await ops.stage(git, work, ['x.txt']);
    await ops.reword(git, work, { hash: (await git.text(['rev-parse', 'HEAD'], work)).trim(), message: '新的 HEAD 訊息' });
    assert.equal((await git.text(['log', '-1', '--format=%s'], work)).trim(), '新的 HEAD 訊息');
    assert.equal((await ops.status(git, work)).staged.length, 1);
    await ops.commit(git, work, { message: 'add x' });
    const mid = (await git.text(['rev-parse', 'HEAD~1'], work)).trim();
    await ops.reword(git, work, { hash: mid, message: '改舊的訊息' });
    assert.deepEqual((await git.text(['log', '--format=%s', `${base}..HEAD`], work)).trim().split('\n'), ['add x', '改舊的訊息']);
    // 重定基底到其他分支
    await ops.createBranch(git, work, { name: 'side', from: base, checkout: true });
    write(work, 'side.txt', 's\n');
    await ops.stage(git, work, ['side.txt']);
    await ops.commit(git, work, { message: 'side' });
    const rr = await ops.rebaseOnto(git, work, { onto: 'main' });
    assert.equal(rr.conflict, false);
    assert.equal((await git.text(['log', '--format=%s', '-2'], work)).trim(), 'side\nadd x');
  });
});

test('檔案歷史（跟著重新命名）、逐行追溯、圖片差異', async () => {
  await withTmp(async (dir) => {
    const { work } = await setup(dir);
    write(work, 'a.txt', 'line1\nLINE2\nline3\n');
    await ops.stageAll(git, work);
    await ops.commit(git, work, { message: '改第二行' });
    await git(['mv', 'a.txt', 'b.txt'], work);
    await ops.commit(git, work, { message: '改名' });
    const h = await ops.fileHistory(git, work, { path: 'b.txt' });
    assert.deepEqual(h.map((x) => x.subject), ['改名', '改第二行', '初始提交']);
    assert.equal(h[0].status, 'R');
    assert.equal(h[0].orig, 'a.txt');
    assert.equal(h[1].path, 'a.txt');
    write(work, 'b.txt', 'line1\nLINE2\nline3\nnew\n');
    const b = await ops.blame(git, work, { path: 'b.txt' });
    assert.deepEqual(b.lines.map((l) => l.text), ['line1', 'LINE2', 'line3', 'new']);
    assert.equal(b.commits[b.lines[1].hash].summary, '改第二行');
    assert.equal(b.commits[b.lines[0].hash].summary, '初始提交');
    assert.match(b.lines[3].hash, /^0+$/);
    // 圖片：二進位時附上 data URL
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    fs.writeFileSync(path.join(work, 'x.png'), png);
    const d = await ops.diffSides(git, work, { area: 'untracked', path: 'x.png' });
    assert.match(d.right.image, /^data:image\/png;base64,/);
  });
});

test('拉取指定遠端分支、比對遠端標籤、擷取時清除標籤、假設未變更', async () => {
  await withTmp(async (dir) => {
    const { remote, work } = await setup(dir);
    await ops.push(git, work, {});
    // 另一份複製推送 feature 分支與標籤
    const other = path.join(dir, 'other');
    await git(['clone', '-q', remote, other], dir);
    await git(['checkout', '-q', '-b', 'feature'], other);
    write(other, 'f.txt', 'f\n');
    await git(['add', '-A'], other);
    await git(['commit', '-qm', 'feature'], other);
    await git(['push', '-q', 'origin', 'feature'], other);
    await git(['tag', 'r1'], other);
    await git(['push', '-q', 'origin', 'r1'], other);
    const r = await ops.pull(git, work, { mode: 'merge', remote: 'origin', branch: 'feature' });
    assert.equal(r.conflict, false);
    assert.ok(fs.existsSync(path.join(work, 'f.txt')));
    await ops.createTag(git, work, { name: 'local-only' });
    const rt = await ops.remoteTags(git, work, {});
    assert.deepEqual(rt.tags, ['r1']);
    // 遠端刪除 r1 後，擷取並清除標籤會刪掉本機的 r1
    await ops.fetchAll(git, work);
    assert.match(await git.text(['tag', '-l', 'r1'], work), /r1/);
    await git(['push', '-q', 'origin', '--delete', 'refs/tags/r1'], other);
    await ops.fetchAll(git, work, undefined, { pruneTags: true });
    assert.equal((await git.text(['tag', '-l', 'r1'], work)).trim(), '');
    // 假設未變更
    write(work, 'a.txt', 'changed\n');
    await ops.assumeUnchanged(git, work, { paths: ['a.txt'] });
    let s = await ops.status(git, work);
    assert.deepEqual(s.unstaged, []);
    assert.deepEqual(s.assumed.map((x) => x.path), ['a.txt']);
    await ops.assumeUnchanged(git, work, { paths: ['a.txt'], on: false });
    s = await ops.status(git, work);
    assert.deepEqual(s.unstaged.map((x) => x.path), ['a.txt']);
    assert.deepEqual(s.assumed, []);
  });
});

test('參照紀錄、比較兩個提交、搜尋歷史、子模組、工作樹', async () => {
  await withTmp(async (dir) => {
    const { remote, work } = await setup(dir);
    const first = (await git.text(['rev-parse', 'HEAD'], work)).trim();
    write(work, 'a.txt', 'line1\nneedle\nline3\n');
    write(work, 'n.txt', 'n\n');
    await ops.stageAll(git, work);
    await ops.commit(git, work, { message: 'Add Needle' });
    const second = (await git.text(['rev-parse', 'HEAD'], work)).trim();
    await ops.reset(git, work, { hash: first, mode: 'hard' });
    const rl = await ops.reflog(git, work);
    assert.ok(rl.some((e) => e.hash === second), 'reset 之前的提交仍在參照紀錄中');
    assert.match(rl[0].action, /reset/);
    await ops.reset(git, work, { hash: second, mode: 'hard' });
    assert.deepEqual((await ops.compareRange(git, work, { from: first, to: second })).map((f) => f.path).sort(), ['a.txt', 'n.txt']);
    const s1 = await ops.log(git, work, { search: { mode: 'content', text: 'needle' } });
    assert.deepEqual(s1.commits.map((c) => c.subject), ['Add Needle']);
    const s2 = await ops.log(git, work, { search: { mode: 'message', text: 'add needle' } });
    assert.equal(s2.commits.length, 1);
    const s3 = await ops.log(git, work, { search: { mode: 'author', text: 'nobody' } });
    assert.equal(s3.commits.length, 0);
    await assert.rejects(ops.log(git, work, { search: { mode: 'content', text: 'a\nb' } }), /換行/);

    // 子模組：用 bare 遠端當子模組的來源
    await ops.push(git, work, {});
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'lib/sub'], work);
    await ops.commit(git, work, { message: 'add submodule' });
    let subs = await ops.submodules(git, work);
    assert.deepEqual(subs.map((x) => [x.path, x.state]), [['lib/sub', 'ok']]);
    const clone = path.join(dir, 'clone');
    await ops.push(git, work, {});
    await git(['clone', '-q', remote, clone], dir);
    subs = await ops.submodules(git, clone);
    assert.equal(subs[0].state, 'uninit');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
    process.env.GIT_CONFIG_VALUE_0 = 'always';
    try { await ops.submoduleUpdate(git, clone, {}); } finally { delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0; }
    assert.equal((await ops.submodules(git, clone))[0].state, 'ok');

    // 工作樹
    const wt = path.join(dir, 'wt');
    await ops.addWorktree(git, work, { dir: wt, newBranch: 'wt-branch' });
    let list = await ops.worktrees(git, work);
    assert.equal(list.length, 2);
    assert.equal(list[0].main, true);
    assert.equal(list[1].branch, 'wt-branch');
    await assert.rejects(ops.removeWorktree(git, work, { dir: work }), /主要/);
    await ops.removeWorktree(git, work, { dir: wt });
    list = await ops.worktrees(git, work);
    assert.equal(list.length, 1);
  });
});
