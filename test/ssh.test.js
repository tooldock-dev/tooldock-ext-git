'use strict';
/* SSH 金鑰：產生、列出、公鑰、切換（core.sshCommand）、測試連線的判讀。需要 git 與 ssh-keygen；沒有 ssh-keygen 時略過相關測試。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../backend/ssh');
const G = require('../backend/git');
const ops = require('../backend/ops');
const backend = require('../backend/index');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
});
const git = G.createRunner({});

let hasKeygen = true;
try { execFileSync('ssh-keygen', ['-l', '-f', os.devNull], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') hasKeygen = false; }
let hasSsh = true;
try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); } catch (e) { if (e.code === 'ENOENT') hasSsh = false; }

async function withTmp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ssh-')));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('網址：SSH 連線目標、HTTPS 轉 SSH', () => {
  assert.deepEqual(S.parseSshUrl('git@github.com:a/b.git'), { user: 'git', host: 'github.com', port: null });
  assert.deepEqual(S.parseSshUrl('ssh://deploy@Git.Corp.com:2222/team/x.git'), { user: 'deploy', host: 'git.corp.com', port: 2222 });
  assert.equal(S.parseSshUrl('https://github.com/a/b.git'), null);
  assert.equal(S.parseSshUrl('/srv/repo.git'), null);
  assert.equal(S.parseSshUrl('C:\\repo'), null);
  assert.equal(S.httpsToSsh('https://github.com/me/app.git'), 'git@github.com:me/app.git');
  assert.equal(S.httpsToSsh('https://token@gitlab.com/group/sub/app'), 'git@gitlab.com:group/sub/app.git');
  assert.equal(S.httpsToSsh('https://bitbucket.org/team/app.git/'), 'git@bitbucket.org:team/app.git');
  assert.equal(S.httpsToSsh('https://git.corp.com/a/b.git'), null);
  assert.equal(S.httpsToSsh('git@github.com:a/b.git'), null);
});

test('core.sshCommand：產生與解析；路徑含特殊字元時拒絕', () => {
  const f = path.join(os.tmpdir(), 'my keys', 'id_work');
  const cmd = S.sshCommandFor(f);
  assert.equal(cmd, `ssh -i "${f.replace(/\\/g, '/')}" -o IdentitiesOnly=yes`);
  assert.deepEqual(S.parseSshCommand(cmd), { keyFile: path.normalize(f.replace(/\\/g, '/')), custom: false });
  assert.deepEqual(S.parseSshCommand(''), { keyFile: null, custom: false });
  assert.equal(S.parseSshCommand('ssh -p 2222').custom, true);
  assert.equal(S.parseSshCommand('ssh -i ~/.ssh/x -v').keyFile, path.normalize('~/.ssh/x'));
  assert.throws(() => S.sshCommandFor('/tmp/a"b'), /不支援/);
  assert.throws(() => S.sshCommandFor('/tmp/$(rm)'), /不支援/);
  assert.throws(() => S.sshCommandFor('relative/key'), /不支援/);
});

test('測試連線的判讀：各網站成功訊息、被拒、主機金鑰改變、找不到主機', () => {
  const r = (stderr, code = 1) => S.interpret({ code, killed: false, stdout: '', stderr });
  const gh = r("Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\nHi andy! You've successfully authenticated, but GitHub does not provide shell access.");
  assert.equal(gh.ok, true);
  assert.equal(gh.hostAdded, true);
  assert.match(gh.message, /^Hi andy/);
  assert.equal(r('Welcome to GitLab, @andy!', 0).ok, true);
  assert.equal(r('authenticated via ssh key.\n\nYou can use git to connect to Bitbucket.', 0).ok, true);
  assert.equal(r('git@github.com: Permission denied (publickey).', 255).code, 'DENIED');
  assert.equal(r('@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.', 255).code, 'HOST_CHANGED');
  assert.equal(r('ssh: Could not resolve hostname nope.invalid: nodename nor servname provided', 255).code, 'NETWORK');
  assert.equal(S.interpret({ code: -1, killed: true, stdout: '', stderr: '' }).code, 'NETWORK');
  assert.equal(r('something odd', 255).message, 'something odd');
});

test('公鑰解析：指紋與 ssh-keygen -l 相同；RSA 長度', { skip: !hasKeygen && '沒有 ssh-keygen' }, () => withTmp(async (dir) => {
  const r = await S.generate({ name: 'id_rsa', type: 'rsa', comment: 'rsa@test' }, { dir });
  const out = execFileSync('ssh-keygen', ['-l', '-f', `${r.file}.pub`], { encoding: 'utf8' });
  assert.ok(out.includes(r.fingerprint), `${out} / ${r.fingerprint}`);
  const k = S.listKeys(dir).find((x) => x.name === 'id_rsa');
  assert.equal(k.bits, 4096);
  assert.equal(k.label, 'RSA');
  assert.equal(k.weak, false);
}));

test('產生金鑰：建立 ~/.ssh、公鑰可讀、不覆蓋、檢查檔名與密碼；列出時標示預設與 config 指定', { skip: !hasKeygen && '沒有 ssh-keygen' }, () => withTmp(async (home) => {
  const dir = path.join(home, '.ssh');
  assert.deepEqual(S.listKeys(dir), []);
  assert.equal(S.suggestName('ed25519', dir), 'id_ed25519');

  const r = await S.generate({ name: 'id_ed25519', comment: 'me@example.com' }, { dir });
  assert.match(r.text, /^ssh-ed25519 \S+ me@example\.com$/);
  assert.equal(r.hasPassphrase, false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.file).mode & 0o077, 0, '私鑰只有自己能讀');
  }
  assert.equal(S.suggestName('ed25519', dir), 'id_ed25519_2');
  await assert.rejects(S.generate({ name: 'id_ed25519' }, { dir }), (e) => e.code === 'EXISTS');
  const before = fs.readFileSync(r.file, 'utf8');
  assert.equal(fs.readFileSync(r.file, 'utf8'), before, '不會覆蓋');

  const work = await S.generate({ name: 'work_key', comment: 'work', passphrase: 'secret-pass' }, { dir });
  assert.equal(work.hasPassphrase, true);
  // 有密碼的私鑰：用錯的密碼讀不到公鑰
  assert.throws(() => execFileSync('ssh-keygen', ['-y', '-P', 'wrong', '-f', work.file], { stdio: 'pipe' }));

  await assert.rejects(S.generate({ name: '../evil' }, { dir }), /檔名/);
  await assert.rejects(S.generate({ name: 'x.pub' }, { dir }), /檔名/);
  await assert.rejects(S.generate({ name: '-oProxyCommand=x' }, { dir }), /檔名/);
  await assert.rejects(S.generate({ name: 'k2', passphrase: '123' }, { dir }), /5 個字元/);
  await assert.rejects(S.generate({ name: 'k3', comment: 'a\nb' }, { dir }), /換行/);
  await assert.rejects(S.generate({ name: 'k4', type: 'dsa' }, { dir }), /類型/);

  fs.writeFileSync(path.join(dir, 'config'), 'Host corp\n  IdentityFile ~/.ssh/work_key\n');
  fs.writeFileSync(path.join(dir, 'orphan.pub'), r.text); // 只有公鑰
  fs.writeFileSync(path.join(dir, 'junk.pub'), 'not a key');
  const keys = S.listKeys(dir);
  assert.deepEqual(keys.map((k) => k.name), ['id_ed25519', 'orphan', 'work_key']);
  assert.deepEqual(keys.map((k) => [k.default, k.configured, k.private]), [[true, false, true], [false, false, false], [false, true, true]]);
  assert.equal(S.publicKey('work_key', dir).text.split(' ')[2], 'work');
  assert.throws(() => S.publicKey('../x', dir), /檔名/);
  assert.throws(() => S.publicKey('nope', dir), /找不到/);
}));

test('切換金鑰：儲存庫與全域的 core.sshCommand；複製時指定金鑰寫入新儲存庫', () => withTmp(async (dir) => {
  const globalCfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(globalCfg, '');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    await git(['init', '-q', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    await git(['add', 'a.txt'], work);
    await git(['commit', '-q', '-m', 'init'], work);

    const cmd = S.sshCommandFor(path.join(dir, 'keys', 'id_work'));
    await ops.setSshCommand(git, work, { scope: 'local', value: cmd });
    await ops.setSshCommand(git, work, { scope: 'global', value: S.sshCommandFor(path.join(dir, 'keys', 'id_me')) });
    let c = await ops.sshCommands(git, work);
    assert.equal(c.local, cmd);
    assert.match(c.global, /id_me/);
    assert.match(fs.readFileSync(globalCfg, 'utf8'), /sshCommand/);
    // 實際生效的是儲存庫的設定
    assert.equal((await git.text(['config', '--get', 'core.sshCommand'], work)).trim(), cmd);

    await ops.setSshCommand(git, work, { scope: 'local', value: '' });
    await ops.setSshCommand(git, work, { scope: 'local', value: '' }); // 沒有設定時移除也不會失敗
    c = await ops.sshCommands(git, work);
    assert.equal(c.local, '');
    await assert.rejects(ops.setSshCommand(git, work, { scope: 'local', value: 'ssh\n-x' }), /換行/);
    await assert.rejects(ops.setSshCommand(git, null, { scope: 'local', value: cmd }), /儲存庫/);

    const dest = await ops.clone(git, { url: work, parent: dir, name: 'copy', sshCommand: cmd }, {});
    assert.equal((await git.text(['config', '--local', '--get', 'core.sshCommand'], dest)).trim(), cmd);

    await ops.setRemoteUrl(git, dest, { name: 'origin', url: 'git@github.com:me/app.git' });
    assert.equal((await git.text(['remote', 'get-url', 'origin'], dest)).trim(), 'git@github.com:me/app.git');
    await assert.rejects(ops.setRemoteUrl(git, dest, { name: 'origin', url: 'ext::sh -c x' }), /不正確|ext::/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
  }
}));

test('後端：SSH 面板的狀態與切換金鑰（以暫存的家目錄執行）', { skip: (!hasKeygen || process.platform === 'win32') && '需要 ssh-keygen（Windows 的家目錄不受 HOME 影響）' }, () => withTmp(async (home) => {
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\temail = me@example.com\n');
  try {
    const data = new Map();
    backend._internal.setContext({
      storage: { get: (k, d) => (data.has(k) ? data.get(k) : d), set: (k, v) => data.set(k, v), delete: (k) => data.delete(k), keys: () => [...data.keys()] },
      settings: { get: (k, d) => d, all: () => ({}) },
      ui: { emit() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    const work = path.join(home, 'work');
    fs.mkdirSync(work);
    await git(['init', '-q', '-b', 'main'], work);
    await git(['remote', 'add', 'origin', 'https://github.com/me/app.git'], work);
    await git(['remote', 'add', 'corp', 'ssh://git@git.corp.com:2222/x.git'], work);
    const { repo } = await backend._internal.addRepo(work);

    let s = await backend._internal.sshState(null);
    assert.equal(s.repo, null);
    assert.equal(s.email, 'me@example.com');
    assert.deepEqual(s.keys, []);
    assert.equal(s.suggest.ed25519, 'id_ed25519');

    await S.generate({ name: 'id_ed25519', comment: 'me' });
    await S.generate({ name: 'work_key', comment: 'work' });
    s = await backend._internal.sshState(repo.id);
    assert.equal(s.dir, path.join(home, '.ssh'));
    assert.deepEqual(s.keys.map((k) => k.name), ['id_ed25519', 'work_key']);
    assert.deepEqual(s.remotes.map((r) => [r.name, r.sshUrl, r.ssh && r.ssh.port]), [['corp', null, 2222], ['origin', 'git@github.com:me/app.git', null]]);

    s = await backend._internal.useKey({ id: repo.id, scope: 'local', key: 'work_key' });
    assert.equal(s.local.key, 'work_key');
    assert.equal(s.local.custom, false);
    assert.equal(s.global.value, '');
    s = await backend._internal.useKey({ id: repo.id, scope: 'global', key: 'id_ed25519' });
    assert.equal(s.global.key, 'id_ed25519');
    s = await backend._internal.useKey({ id: repo.id, scope: 'local', key: '' });
    assert.equal(s.local.value, '');
    await assert.rejects(backend._internal.useKey({ id: repo.id, scope: 'local', key: 'missing' }), /找不到私鑰/);

    // 別人設的自訂指令：辨識為 custom，不當成某把金鑰
    await git(['config', '--local', 'core.sshCommand', 'ssh -o ProxyJump=bastion'], work);
    s = await backend._internal.sshState(repo.id);
    assert.deepEqual([s.local.custom, s.local.key], [true, null]);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
  }
}));

test('測試連線：找不到主機時回報 NETWORK；參數檢查', { skip: !hasSsh && '沒有 ssh' }, async () => {
  const r = await S.testConnection({ host: 'tooldock-selftest.invalid' }, { timeout: 20000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NETWORK', r.raw);
  await assert.rejects(S.testConnection({ host: '-oProxyCommand=x' }), /主機/);
  await assert.rejects(S.testConnection({ host: 'github.com', user: 'a b' }), /使用者/);
  await assert.rejects(S.testConnection({ host: 'github.com', port: 70000 }), /連接埠/);
  await assert.rejects(S.testConnection({ host: 'github.com', keyFile: '/nope/key' }), /私鑰/);
});

test('錯誤說明：SSH 金鑰被拒、主機金鑰未確認、主機金鑰改變', () => {
  assert.equal(G.explain('git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.').code, 'SSH_KEY');
  assert.equal(G.explain('Host key verification failed.\nfatal: Could not read from remote repository.').code, 'SSH_HOST');
  assert.equal(G.explain('No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.').code, 'SSH_HOST');
  assert.equal(G.explain('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed.').code, 'SSH_HOST_CHANGED');
  assert.equal(G.explain('ERROR: Repository not found.\nfatal: Could not read from remote repository.').code, 'NOT_FOUND');
});
