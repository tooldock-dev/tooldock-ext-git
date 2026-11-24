'use strict';
/**
 * Git 指令的執行與輸出解析。
 *
 * - 一律以參數陣列執行 git（不經過 shell），路徑放在 `--` 之後，分支與提交名稱不接受 `-` 開頭，避免被當成選項。
 * - GIT_TERMINAL_PROMPT=0：需要帳號密碼時直接失敗，不會卡在看不到的終端機提示；
 *   帳號密碼交給系統的認證管理員（macOS 鑰匙圈、Windows Git Credential Manager）或 SSH 金鑰。
 * - 網路操作（clone、fetch、pull、push）以 --progress 把進度逐段回報，可以取消，超過時間會中止。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_BLOB = 10 * 1024 * 1024;
const FALLBACK = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
  : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];

const STATUS_TEXT = { M: '修改', A: '新增', D: '刪除', R: '重新命名', C: '複製', T: '類型變更', U: '衝突', '?': '未追蹤' };
const CONFLICT_TEXT = {
  UU: '雙方都修改', AA: '雙方都新增', DD: '雙方都刪除',
  AU: '我方新增', UA: '對方新增', DU: '我方刪除、對方修改', UD: '我方修改、對方刪除',
};
const CONFLICT = new Set(Object.keys(CONFLICT_TEXT));

/* ───────────── 參數檢查 ───────────── */

/** 儲存庫內的相對路徑（正斜線）；跳出儲存庫或指到 .git 時丟出錯誤 */
function safeRel(top, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('路徑不正確');
  const full = path.resolve(top, rel);
  const root = path.resolve(top);
  if (!full.startsWith(root + path.sep)) throw new Error('路徑不在儲存庫內');
  const r = path.relative(root, full).split(path.sep).join('/');
  if (r === '.git' || r.startsWith('.git/')) throw new Error('不能操作 .git 資料夾');
  return r;
}

function safePaths(top, list) {
  if (!Array.isArray(list) || !list.length) throw new Error('沒有指定檔案');
  return list.map((p) => safeRel(top, p));
}

/** 分支、標籤、提交等名稱：不可以 - 開頭（避免被當成選項）或含控制字元 */
function safeRef(ref, what = '名稱') {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error(`${what}不能是空的`);
  // eslint-disable-next-line no-control-regex
  if (ref.startsWith('-') || /[\0-\x1f\x7f]/.test(ref)) throw new Error(`${what}不正確：${ref}`);
  return ref.trim();
}

const chunk = (list, n = 100) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/* ───────────── 錯誤說明 ───────────── */

/** 把 git 的錯誤輸出整理成中文說明與錯誤代碼；原始輸出仍保留在 err.stderr */
function explain(stderr = '', stdout = '') {
  const all = `${stderr}\n${stdout}`;
  const rules = [
    [/Please tell me who you are|unable to auto-detect email address|empty ident name/i, 'NO_IDENTITY', '還沒有設定提交者的名稱與 email'],
    [/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/i, 'AUTH',
      '遠端需要登入。請先在終端機對這個遠端執行一次 git（讓系統的認證管理員記住帳號），或改用 SSH 金鑰'],
    [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, 'SSH_HOST_CHANGED', 'SSH 主機金鑰和上次記住的不同，git 拒絕連線（可能是主機換了金鑰，也可能有人冒充）。請先向對方確認新的主機金鑰'],
    [/Host key verification failed|No .* host key is known/i, 'SSH_HOST', 'SSH 主機金鑰還沒有確認。請在「SSH 金鑰」測試一次連線，記住這台主機'],
    [/Permission denied \(publickey/i, 'SSH_KEY', '無法用 SSH 金鑰登入遠端。請在「SSH 金鑰」產生金鑰，並把公鑰加到遠端帳號'],
    [/Could not resolve host|unable to access .*(Failed to connect|Couldn't connect|timed out)|Connection (refused|timed out)|Network is unreachable/i, 'NETWORK', '無法連線到遠端，請檢查網路或遠端網址'],
    [/repository .* not found|does not appear to be a git repository|Repository not found/i, 'NOT_FOUND', '找不到遠端儲存庫，請確認網址與權限'],
    [/Could not read from remote repository/i, 'AUTH', '無法讀取遠端儲存庫。請確認有這個儲存庫的權限，使用 SSH 時請確認公鑰已加到遠端帳號'],
    [/\[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because/i, 'REJECTED', '遠端有你還沒有的提交，推送被拒絕。請先拉取（pull）再推送'],
    [/Not possible to fast-forward|fatal: Not possible to fast-forward/i, 'NOT_FF', '無法快轉：本機與遠端各有新的提交。請改用合併或重定基底的拉取方式'],
    [/no tracking information|There is no tracking information/i, 'NO_UPSTREAM', '目前分支沒有設定追蹤的遠端分支'],
    [/has no upstream branch/i, 'NO_UPSTREAM', '目前分支還沒有遠端分支'],
    [/would be overwritten by (merge|checkout)|Your local changes to the following files would be overwritten|commit your changes or stash them/i, 'DIRTY',
      '有尚未提交的變更會被覆蓋。請先提交或儲藏（stash）這些變更'],
    [/cannot rebase: (You have unstaged changes|Your index contains uncommitted changes)|cannot (rebase|pull with rebase): You have unstaged changes/i, 'DIRTY',
      '有尚未提交的變更，無法重定基底。請先提交或儲藏（stash）這些變更'],
    [/untracked working tree files would be (overwritten|removed)/i, 'DIRTY', '有未追蹤的檔案會被覆蓋。請先移走、加入或儲藏這些檔案'],
    [/You have not concluded your merge|MERGE_HEAD exists|you need to resolve your current index first|Merging is not possible because you have unmerged files|Committing is not possible because you have unmerged files/i, 'UNMERGED',
      '還有未解決的衝突或未完成的合併。請先解決衝突並完成合併，或中止合併'],
    [/index\.lock': File exists|Unable to create .*\.lock/i, 'LOCKED', '儲存庫正被另一個 git 程序使用（index.lock）。請稍後再試；確定沒有其他 git 在執行時，可以刪除 .git/index.lock'],
    [/nothing to commit|no changes added to commit/i, 'NOTHING', '沒有可以提交的變更'],
    [/is not fully merged/i, 'NOT_MERGED', '這個分支還有沒合併的提交'],
    [/already exists/i, 'EXISTS', ''],
    [/not a git repository/i, 'NOT_REPO', '這個資料夾不是 Git 儲存庫'],
    [/refusing to merge unrelated histories/i, 'UNRELATED', '兩邊沒有共同的歷史，拒絕合併'],
    [/couldn't find remote ref|unknown revision|bad revision|not a valid object name|did not match any/i, 'NO_REF', '找不到指定的分支或提交'],
    [/dubious ownership/i, 'UNSAFE', '儲存庫的擁有者和目前使用者不同，git 拒絕操作。請在終端機依 git 的提示執行 git config --global --add safe.directory <路徑>'],
  ];
  for (const [re, code, msg] of rules) {
    if (re.test(all)) {
      const raw = firstError(stderr) || firstError(stdout);
      return { code, message: msg || raw || 'git 執行失敗' };
    }
  }
  return { code: 'GIT_FAILED', message: firstError(stderr) || firstError(stdout) || '' };
}

/** 取出最有意義的一行（fatal / error 優先），略過 hint 與進度 */
function firstError(text) {
  const lines = String(text || '').split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l));
  const hit = lines.find((l) => /^(fatal|error):/i.test(l));
  return (hit || lines[lines.length - 1] || '').replace(/^(fatal|error):\s*/i, '');
}

/* ───────────── 執行 ───────────── */

/** 結束 git 與它啟動的子程序 */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

function spawnGit(bin, args, { cwd, input, timeout, env, onProgress, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let canceled = false;
    let size = 0;
    const out = [];
    const err = [];
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        // 新的程序群組：取消時連同 git 啟動的 ssh、git-remote-https 一起結束
        detached: process.platform !== 'win32',
        // LANGUAGE：git 的訊息固定為英文，錯誤才能可靠地辨識（畫面顯示的是 explain() 整理過的中文）
        env: { ...process.env, LANGUAGE: 'en_US:en', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', ...env },
      });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = timeout ? setTimeout(() => { timedOut = true; killTree(child); }, timeout) : null;
    if (onSpawn) onSpawn(() => { canceled = true; killTree(child); });
    child.on('error', (e) => finish(reject, e));
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_OUTPUT) { killTree(child); return; }
      out.push(d);
    });
    child.stderr.on('data', (d) => {
      err.push(d);
      if (onProgress) onProgress(d.toString('utf8'));
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0 && !canceled && !timedOut) { finish(resolve, { stdout, stderr }); return; }
      const ex = explain(stderr, stdout.toString('utf8'));
      let message = ex.message || `git ${args.find((a) => !a.startsWith('-')) || ''} 失敗（結束代碼 ${code}）`;
      let codeName = ex.code;
      if (canceled) { message = '已取消'; codeName = 'CANCELED'; } else if (timedOut) { message = '逾時，已中止'; codeName = 'TIMEOUT'; } else if (size > MAX_OUTPUT) message = '輸出太大';
      const e = new Error(message);
      e.code = codeName;
      e.exitCode = code;
      e.stderr = stderr;
      e.stdout = stdout.toString('utf8');
      finish(reject, e);
    });
    child.stdin.on('error', () => { /* 程序提早結束時忽略 */ });
    child.stdin.end(input == null ? undefined : input);
  });
}

/**
 * 建立 git 執行器。
 * @param {{ gitPath?: () => string, onLog?: (entry: object) => void }} opts
 */
function createRunner({ gitPath = () => '', onLog = () => {} } = {}) {
  let resolved = null;

  /** 執行 git；找不到 git 時依序嘗試常見的安裝位置（打包後的 App 不一定有使用者的 PATH） */
  async function git(args, cwd, opts = {}) {
    const candidates = [gitPath(), resolved, 'git', ...FALLBACK].filter(Boolean);
    const started = Date.now();
    let last;
    for (const bin of [...new Set(candidates)]) {
      try {
        const r = await spawnGit(bin, args, { cwd, ...opts });
        resolved = bin;
        if (!opts.quiet) onLog({ args, cwd, ok: true, ms: Date.now() - started, output: tail(r.stderr || '') });
        return r;
      } catch (err) {
        if (err.code === 'ENOENT' && !err.stderr) { last = err; continue; }
        if (!opts.quiet || opts.logErrors) onLog({ args, cwd, ok: false, ms: Date.now() - started, output: tail(`${err.stderr || ''}${err.stdout ? `\n${err.stdout}` : ''}`), message: err.message });
        throw err;
      }
    }
    // cwd 不存在時 spawn 也會回報 ENOENT
    if (cwd && !fs.existsSync(cwd)) throw new Error(`資料夾不存在：${cwd}`);
    const e = new Error('找不到 git，請先安裝 Git，或在設定中指定 git 執行檔位置');
    e.code = 'NO_GIT';
    e.cause = last;
    throw e;
  }
  git.text = async (args, cwd, opts) => (await git(args, cwd, opts)).stdout.toString('utf8');
  git.version = async () => (await git.text(['--version'], undefined, { quiet: true })).trim();
  /** 實際使用的 git 執行檔（執行過一次 git 之後才確定）；Windows 上用來找 Git 附帶的 ssh */
  git.bin = () => resolved || gitPath() || null;
  return git;
}

/** 輸出只保留最後一段（進度訊息以 \r 覆寫，只留最後的狀態） */
function tail(s, max = 4000) {
  const lines = String(s).split('\n').map((l) => l.split('\r').filter(Boolean).pop() || '').filter((l) => l.trim());
  const t = lines.join('\n');
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/* ───────────── 解析 ───────────── */

/** git status --porcelain=v1 -z -b */
function parseStatus(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, gone: false, noCommits: false, detached: false, entries: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const h = p.slice(3);
      let m;
      if ((m = h.match(/^No commits yet on (.+)$/)) || (m = h.match(/^Initial commit on (.+)$/))) {
        out.branch = m[1];
        out.noCommits = true;
      } else if (h.startsWith('HEAD (no branch)')) {
        out.detached = true;
      } else {
        m = h.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
        if (m) {
          out.branch = m[1];
          out.upstream = m[2] || '';
          const ab = m[3] || '';
          out.ahead = Number((ab.match(/ahead (\d+)/) || [])[1] || 0);
          out.behind = Number((ab.match(/behind (\d+)/) || [])[1] || 0);
          out.gone = ab === 'gone';
        }
      }
      continue;
    }
    const xy = p.slice(0, 2);
    const file = p.slice(3);
    let orig = '';
    if (xy[0] === 'R' || xy[0] === 'C') orig = parts[++i] || '';
    out.entries.push({ xy, path: file, orig });
  }
  return out;
}

/** 依衝突／已暫存／變更／未追蹤分組 */
function group(entries) {
  const g = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const e of entries) {
    if (e.xy === '!!') continue;
    if (e.xy === '??') { g.untracked.push({ path: e.path, status: '?', label: STATUS_TEXT['?'] }); continue; }
    if (CONFLICT.has(e.xy)) { g.conflict.push({ path: e.path, status: 'U', xy: e.xy, label: CONFLICT_TEXT[e.xy] }); continue; }
    const [x, y] = e.xy;
    if (x !== ' ') g.staged.push({ path: e.path, status: x, orig: e.orig || undefined, label: STATUS_TEXT[x] || x });
    if (y !== ' ') g.unstaged.push({ path: e.path, status: y, label: STATUS_TEXT[y] || y });
  }
  return g;
}

/** %D 搭配 --decorate=full：HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1 */
function parseRefs(d) {
  const refs = [];
  for (let s of String(d || '').split(', ')) {
    s = s.trim();
    if (!s) continue;
    let head = false;
    if (s.startsWith('HEAD -> ')) { head = true; s = s.slice(8); }
    if (s === 'HEAD') { refs.push({ type: 'head', name: 'HEAD' }); continue; }
    if (s.startsWith('tag: ')) s = s.slice(5);
    if (s.startsWith('refs/heads/')) refs.push({ type: 'local', name: s.slice(11), head });
    else if (s.startsWith('refs/remotes/')) { if (!s.endsWith('/HEAD')) refs.push({ type: 'remote', name: s.slice(13) }); } else if (s.startsWith('refs/tags/')) refs.push({ type: 'tag', name: s.slice(10) });
    else if (s !== 'refs/stash') refs.push({ type: 'other', name: s });
  }
  return refs;
}

const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f');

/** git log -z --format=LOG_FORMAT */
function parseLog(text) {
  return String(text).split('\0').filter((r) => r.trim()).map((r) => {
    const [hash, parents, author, email, at, refs, subject] = r.replace(/^\n/, '').split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      time: Number(at) * 1000,
      refs: parseRefs(refs),
      subject: subject || '',
    };
  });
}

/** git diff --name-status -z -M */
function parseNameStatus(text) {
  const parts = String(text).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const status = s[0];
    if (status === 'R' || status === 'C') {
      const orig = parts[++i];
      const p = parts[++i];
      out.push({ status, orig, path: p, score: Number(s.slice(1)) || undefined, label: STATUS_TEXT[status] });
    } else {
      out.push({ status, path: parts[++i], label: STATUS_TEXT[status] || status });
    }
  }
  return out;
}

/** git for-each-ref --format=REF_FORMAT */
const REF_FORMAT = ['%(refname)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(committerdate:unix)', '%(contents:subject)'].join('%00');
function parseBranches(text) {
  const out = { local: [], remote: [], tags: [] };
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const [ref, short, upstream, track, head, at, subject] = line.split('\0');
    const item = { hash: short, time: Number(at) * 1000 || 0, subject: subject || '' };
    if (ref.startsWith('refs/heads/')) {
      out.local.push({
        ...item,
        name: ref.slice(11),
        upstream: upstream || '',
        ahead: Number((track.match(/ahead (\d+)/) || [])[1] || 0),
        behind: Number((track.match(/behind (\d+)/) || [])[1] || 0),
        gone: track === '[gone]',
        current: head === '*',
      });
    } else if (ref.startsWith('refs/remotes/')) {
      if (!ref.endsWith('/HEAD')) out.remote.push({ ...item, name: ref.slice(13) });
    } else if (ref.startsWith('refs/tags/')) {
      out.tags.push({ ...item, name: ref.slice(10) });
    }
  }
  return out;
}

/** git stash list -z --format=%gd%x1f%at%x1f%gs */
function parseStashes(text) {
  return String(text).split('\0').filter(Boolean).map((r) => {
    const [ref, at, subject] = r.split('\x1f');
    return { ref, time: Number(at) * 1000, subject: subject || '' };
  });
}

/** git remote -v */
function parseRemotes(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!m) continue;
    const r = map.get(m[1]) || { name: m[1], fetch: '', push: '' };
    r[m[3]] = m[2];
    map.set(m[1], r);
  }
  return [...map.values()].map((r) => ({ name: r.name, url: r.fetch || r.push, pushUrl: r.push || r.fetch }));
}

/* ───────────── 內容 ───────────── */

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };
const MAX_IMAGE = 5 * 1024 * 1024;

/** Buffer → 文字；記錄 BOM，二進位或過大時回傳說明。rel 是圖片時附上 data URL（圖片差異用） */
function decode(buf, rel = '') {
  if (buf.length > MAX_BLOB) return { text: '', tooLarge: true, note: `檔案超過 ${MAX_BLOB / 1024 / 1024} MB，不顯示內容` };
  if (isBinary(buf)) {
    const type = IMAGE_TYPES[(/\.([^./]+)$/.exec(rel) || [])[1]?.toLowerCase()];
    if (type && buf.length <= MAX_IMAGE) return { text: '', binary: true, image: `data:${type};base64,${buf.toString('base64')}`, size: buf.length, note: '圖片' };
    return { text: '', binary: true, size: buf.length, note: '二進位檔案' };
  }
  let s = buf;
  let bom = false;
  if (s[0] === 0xef && s[1] === 0xbb && s[2] === 0xbf) { s = s.subarray(3); bom = true; }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(s), bom };
  } catch {
    return { text: new TextDecoder('big5').decode(s), note: '以 Big5 解碼', readOnly: true };
  }
}

function readWorking(top, rel) {
  const f = path.join(top, rel);
  try {
    const st = fs.statSync(f);
    if (st.isDirectory()) return { exists: true, text: '', note: '子模組或資料夾', binary: true };
    if (st.size > MAX_BLOB) return { exists: true, text: '', tooLarge: true, note: `檔案超過 ${MAX_BLOB / 1024 / 1024} MB，不顯示內容` };
    return { exists: true, ...decode(fs.readFileSync(f), rel) };
  } catch {
    return { exists: false, text: '' };
  }
}

module.exports = {
  createRunner, spawnGit, explain, firstError, tail,
  safeRel, safePaths, safeRef, chunk,
  parseStatus, group, parseRefs, parseLog, parseNameStatus, parseBranches, parseStashes, parseRemotes,
  LOG_FORMAT, REF_FORMAT, STATUS_TEXT, CONFLICT_TEXT,
  isBinary, decode, readWorking, MAX_BLOB,
};
