'use strict';
/**
 * SSH 金鑰：列出 ~/.ssh 中的金鑰、產生新金鑰、讀取公鑰、測試連線。
 *
 * - 只讀寫 ~/.ssh；檔名限制英數與 . _ -，不會覆蓋已存在的金鑰。
 * - 私鑰內容從不讀取、也不回傳畫面；畫面只拿得到公鑰（.pub）。
 * - ssh、ssh-keygen 以參數陣列執行（不經過 shell）。Windows 上優先使用 Git 附帶的版本（和 git 用同一套 known_hosts 與設定）。
 * - 測試連線使用 BatchMode（不會等待輸入）與 StrictHostKeyChecking=accept-new：
 *   第一次連線時記住主機金鑰；已記住的主機金鑰改變時拒絕連線。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/** ssh 沒有在 config 指定 IdentityFile 時會自動嘗試的金鑰檔名 */
const DEFAULT_NAMES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk', 'id_xmss', 'id_dsa'];
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 可以直接開啟「新增 SSH 金鑰」頁面的網站 */
const ADD_KEY_PAGES = {
  'github.com': { title: 'GitHub', url: 'https://github.com/settings/ssh/new' },
  'gitlab.com': { title: 'GitLab', url: 'https://gitlab.com/-/user_settings/ssh_keys' },
  'bitbucket.org': { title: 'Bitbucket', url: 'https://bitbucket.org/account/settings/ssh-keys/' },
};

const sshDir = (home = os.homedir()) => path.join(home, '.ssh');

function checkName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n) || n.includes('..') || /\.pub$/i.test(n)) throw new Error('金鑰檔名只能有英數與 . _ -，而且不能以 .pub 結尾');
  return n;
}

/* ───────────── 執行 ssh、ssh-keygen ───────────── */

/** 依序嘗試的執行檔：Windows 上 Git 附帶的版本優先，其次是 PATH 與系統內建的 OpenSSH */
function candidates(tool, gitBin) {
  if (process.platform !== 'win32') return [tool];
  const exe = `${tool}.exe`;
  const list = [];
  if (gitBin && path.isAbsolute(gitBin)) {
    // ...\Git\cmd\git.exe 或 ...\Git\bin\git.exe → ...\Git\usr\bin\ssh.exe
    list.push(path.join(path.dirname(path.dirname(gitBin)), 'usr', 'bin', exe));
  }
  list.push(exe);
  const sys = process.env.SystemRoot || 'C:\\Windows';
  list.push(path.join(sys, 'System32', 'OpenSSH', exe));
  list.push('C:\\Program Files\\Git\\usr\\bin\\' + exe);
  return [...new Set(list)];
}

function execOnce(bin, args, { timeout = 20000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      // LANG：訊息固定英文以便辨識；DISPLAY、SSH_ASKPASS 清空：不會跳出看不到的密碼視窗
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', DISPLAY: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', ...env },
    }, (err, stdout, stderr) => {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) { reject(Object.assign(new Error(`找不到 ${path.basename(bin)}`), { code: 'NO_TOOL' })); return; }
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 執行 ssh / ssh-keygen；找不到時回報 NO_TOOL */
async function runTool(tool, args, { gitBin, timeout, env } = {}) {
  let last = null;
  for (const bin of candidates(tool, gitBin)) {
    try {
      return await execOnce(bin, args, { timeout, env });
    } catch (err) {
      if (err.code !== 'NO_TOOL') throw err;
      last = err;
    }
  }
  const e = new Error(`找不到 ${tool}。macOS 與 Linux 內建 OpenSSH；Windows 請安裝 Git for Windows（附帶 ssh），或在系統的「選用功能」加入 OpenSSH 用戶端`);
  e.code = 'NO_TOOL';
  e.cause = last;
  throw e;
}

/* ───────────── 列出金鑰 ───────────── */

/** 解析公鑰一行：「類型 base64 註解」；指紋與 ssh-keygen -l 相同（SHA256:base64 不補 =） */
function parsePublicKey(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  const m = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(line);
  if (!m) return null;
  const blob = Buffer.from(m[2], 'base64');
  if (blob.length < 20) return null;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  const type = m[1];
  const label = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ssh-dss': 'DSA', 'sk-ssh-ed25519@openssh.com': 'ED25519-SK', 'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA-SK' }[type]
    || (/^ecdsa-sha2-/.test(type) ? 'ECDSA' : type);
  // RSA 長度：blob 內第三個欄位是 modulus
  let bits = null;
  if (type === 'ssh-rsa') {
    try {
      let o = 0;
      const field = () => { const n = blob.readUInt32BE(o); o += 4; const v = blob.subarray(o, o + n); o += n; return v; };
      field(); field();
      const mod = field();
      bits = (mod.length - (mod[0] === 0 ? 1 : 0)) * 8;
    } catch { bits = null; }
  }
  return { type, label, bits, comment: (m[3] || '').trim(), fingerprint, line: `${m[1]} ${m[2]}${m[3] ? ` ${m[3].trim()}` : ''}` };
}

/** ~/.ssh/config 中以 IdentityFile 指定的檔名（只比對檔名，不展開萬用字元） */
function configuredNames(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'config'), 'utf8'); } catch { return new Set(); }
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*IdentityFile\s*=?\s*("?)(.+?)\1\s*$/i.exec(line);
    if (m) out.add(path.basename(m[2].replace(/\\/g, '/')));
  }
  return out;
}

/** 列出金鑰：有 .pub 的才列出；private 表示私鑰檔是否存在 */
function listKeys(dir = sshDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const configured = configuredNames(dir);
  const out = [];
  for (const f of names) {
    if (!/\.pub$/i.test(f)) continue;
    const name = f.slice(0, -4);
    if (!NAME_RE.test(name)) continue;
    let info;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile() || st.size > 16 * 1024) continue;
      info = parsePublicKey(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch { continue; }
    if (!info) continue;
    const isDefault = DEFAULT_NAMES.includes(name);
    out.push({
      name,
      file: path.join(dir, f),
      private: fs.existsSync(path.join(dir, name)),
      default: isDefault,
      configured: configured.has(name),
      label: info.label,
      bits: info.bits,
      comment: info.comment,
      fingerprint: info.fingerprint,
      weak: info.type === 'ssh-dss' || (info.bits !== null && info.bits < 2048),
    });
  }
  // ssh 預設的金鑰排前面（依 ssh 嘗試的順序），其他依檔名
  const rank = (k) => (k.default ? DEFAULT_NAMES.indexOf(k.name) : 100);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return out;
}

/** 讀取公鑰（給使用者複製）；只讀 .pub */
function publicKey(name, dir = sshDir()) {
  const n = checkName(name);
  let text;
  try { text = fs.readFileSync(path.join(dir, `${n}.pub`), 'utf8'); } catch { throw new Error(`找不到公鑰 ${n}.pub`); }
  const info = parsePublicKey(text);
  if (!info) throw new Error(`${n}.pub 不是有效的公鑰`);
  return { name: n, text: info.line, fingerprint: info.fingerprint };
}

/** 建議的新金鑰檔名：id_ed25519，已存在時加上 _2、_3… */
function suggestName(type = 'ed25519', dir = sshDir()) {
  const base = type === 'rsa' ? 'id_rsa' : 'id_ed25519';
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? base : `${base}_${i}`;
    if (!fs.existsSync(path.join(dir, n)) && !fs.existsSync(path.join(dir, `${n}.pub`))) return n;
  }
  return `${base}_${Date.now()}`;
}

/* ───────────── 產生金鑰 ───────────── */

/**
 * 產生金鑰。type：ed25519（建議）或 rsa（4096 位元，給不支援 ed25519 的舊伺服器）。
 * passphrase 為空字串時不設密碼。已存在同名檔案時拒絕（不覆蓋）。
 */
async function generate({ name, type = 'ed25519', comment = '', passphrase = '' } = {}, { dir = sshDir(), gitBin } = {}) {
  const n = checkName(name);
  if (!['ed25519', 'rsa'].includes(type)) throw new Error('金鑰類型只能是 ed25519 或 rsa');
  const c = String(comment || '').trim();
  // eslint-disable-next-line no-control-regex
  if (c.length > 200 || /[\0-\x1f\x7f]/.test(c)) throw new Error('註解不能超過 200 個字，也不能換行');
  const pass = String(passphrase || '');
  if (pass && pass.length < 5) throw new Error('密碼至少要 5 個字元（或留空不設密碼）');
  if (pass.length > 1024 || /[\r\n\0]/.test(pass)) throw new Error('密碼不能換行');
  const file = path.join(dir, n);
  if (fs.existsSync(file) || fs.existsSync(`${file}.pub`)) {
    const e = new Error(`~/.ssh 已經有 ${n}，不會覆蓋。請換一個檔名`);
    e.code = 'EXISTS';
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // ssh 要求 ~/.ssh 不能讓其他人寫入
  if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch { /* 不是自己的資料夾時忽略 */ } }
  const args = ['-q', '-t', type, ...(type === 'rsa' ? ['-b', '4096'] : []), '-C', c, '-f', file, '-N', pass];
  const r = await runTool('ssh-keygen', args, { gitBin, timeout: 60000 });
  if (r.code !== 0 || !fs.existsSync(`${file}.pub`)) {
    const msg = (r.stderr || r.stdout).trim().split(/\r?\n/).pop() || `ssh-keygen 結束代碼 ${r.code}`;
    throw new Error(`無法產生金鑰：${msg}`);
  }
  return { ...publicKey(n, dir), file, hasPassphrase: !!pass };
}

/* ───────────── 切換金鑰（git 的 core.sshCommand） ───────────── */

/**
 * 指定金鑰的 core.sshCommand：ssh -i "<私鑰>" -o IdentitiesOnly=yes
 * IdentitiesOnly：只用這把金鑰，不再嘗試 ssh-agent 裡的其他金鑰（同一個網站有多個帳號時才不會登錯帳號）。
 * git 以 shell 執行這個指令，所以路徑改用正斜線並加上雙引號，含 " $ ` \ 的路徑拒絕。
 */
function sshCommandFor(keyFile) {
  const f = String(keyFile || '').replace(/\\/g, '/');
  if (!f || !path.isAbsolute(keyFile) || /["$`\\\n\r]/.test(f)) throw new Error('金鑰路徑含有不支援的字元');
  return `ssh -i "${f}" -o IdentitiesOnly=yes`;
}

/**
 * 解析 core.sshCommand：回傳 { keyFile, custom }。
 * keyFile：這個工具設定的格式（或其他帶 -i 的寫法）中的私鑰路徑；custom：不是這個工具設定的格式（切換時要先確認）。
 */
function parseSshCommand(value) {
  const v = String(value || '').trim();
  if (!v) return { keyFile: null, custom: false };
  const m = /^ssh\s+-i\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+-o\s+IdentitiesOnly=yes$/.exec(v);
  if (m) return { keyFile: path.normalize(m[1] || m[2] || m[3]), custom: false };
  const any = /\s-i\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(` ${v}`);
  return { keyFile: any ? path.normalize(any[1] || any[2] || any[3]) : null, custom: true };
}

/** 金鑰名稱 → 私鑰的完整路徑（必須存在） */
function keyFileOf(name, dir = sshDir()) {
  const n = checkName(name);
  const f = path.join(dir, n);
  if (!fs.existsSync(f)) throw new Error(`找不到私鑰 ~/.ssh/${n}`);
  return f;
}

/* ───────────── 測試連線 ───────────── */

/** 遠端網址 → SSH 連線目標 { user, host, port }；不是 SSH 網址時回傳 null */
function parseSshUrl(url) {
  const u = String(url || '').trim();
  let m = /^(?:ssh|git\+ssh|ssh\+git):\/\/(?:([^@/:]+)@)?([^/:]+)(?::(\d+))?\//i.exec(u);
  if (m) return { user: m[1] || 'git', host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : null };
  m = /^(?:([^@/:\s]+)@)?([A-Za-z0-9.-]{2,}):(?!\/\/)[^\\]/.exec(u);
  if (m && !/^[A-Za-z]:[\\/]/.test(u) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { user: m[1] || 'git', host: m[2].toLowerCase(), port: null };
  return null;
}

/** HTTPS 網址 → 對應的 SSH 網址（只處理 GitHub、GitLab、Bitbucket 的標準格式）；不能轉換時回傳 null */
function httpsToSsh(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = /^https?:\/\/(?:[^@/]*@)?(github\.com|gitlab\.com|bitbucket\.org)\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)$/i.exec(u);
  if (!m) return null;
  return `git@${m[1].toLowerCase()}:${m[2]}.git`;
}

/**
 * 測試 SSH 連線（ssh -T）。回傳 { ok, code, message, raw, hostAdded }。
 * 各網站登入成功時的訊息不同（GitHub 結束代碼是 1），所以依輸出判斷。
 */
async function testConnection({ host, user = 'git', port = null, keyFile = null } = {}, { gitBin, timeout = 25000 } = {}) {
  const h = String(host || '').trim().toLowerCase();
  if (!HOST_RE.test(h)) throw new Error('主機名稱不正確');
  const u = String(user || 'git').trim();
  if (!USER_RE.test(u)) throw new Error('使用者名稱不正確');
  const p = port === null || port === undefined || port === '' ? null : Number(port);
  if (p !== null && !(Number.isInteger(p) && p > 0 && p < 65536)) throw new Error('連接埠不正確');
  if (keyFile && (!path.isAbsolute(keyFile) || !fs.existsSync(keyFile))) throw new Error('找不到指定的私鑰');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
    ...(keyFile ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes'] : []), ...(p ? ['-p', String(p)] : []), `${u}@${h}`];
  const r = await runTool('ssh', args, { gitBin, timeout });
  return interpret(r);
}

function interpret({ code, killed, stdout, stderr }) {
  const raw = `${stderr}\n${stdout}`.trim();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hostAdded = lines.some((l) => /Permanently added/i.test(l));
  const pick = (re) => lines.find((l) => re.test(l)) || '';
  const ok = /successfully authenticated|Welcome to GitLab|logged in as|authenticated via (an )?ssh key|You can use git to connect|shell access is not supported/i;
  const res = (o) => ({ hostAdded, raw, ...o });
  if (ok.test(raw)) return res({ ok: true, code: 'OK', message: pick(ok) });
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(raw)) return res({ ok: false, code: 'HOST_CHANGED', message: '這台主機的金鑰和上次記住的不同，已拒絕連線。可能是主機換了金鑰，也可能有人冒充；請先向對方確認，再從 ~/.ssh/known_hosts 移除舊的紀錄' });
  if (/Host key verification failed/i.test(raw)) return res({ ok: false, code: 'HOST_KEY', message: '無法確認主機金鑰' });
  if (/Permission denied \(publickey/i.test(raw)) return res({ ok: false, code: 'DENIED', message: '連得上主機，但伺服器不接受這台電腦的金鑰。請把公鑰加到你在這個網站的帳號（設了密碼的金鑰要先加入 ssh-agent）' });
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(raw)) return res({ ok: false, code: 'NETWORK', message: '找不到這台主機，請確認主機名稱與網路' });
  if (killed || /timed out|Connection refused|Network is unreachable|No route to host/i.test(raw)) return res({ ok: false, code: 'NETWORK', message: '無法連線到主機（逾時或被拒絕），請確認網路、防火牆與連接埠' });
  if (/passphrase/i.test(raw)) return res({ ok: false, code: 'PASSPHRASE', message: '金鑰有設密碼，需要先加入 ssh-agent' });
  const last = lines.filter((l) => !/Permanently added/i.test(l)).pop() || `ssh 結束代碼 ${code}`;
  return res({ ok: false, code: 'FAILED', message: last });
}

module.exports = {
  ADD_KEY_PAGES, DEFAULT_NAMES, sshDir, checkName, parsePublicKey, listKeys, publicKey, suggestName, generate,
  parseSshUrl, httpsToSsh, testConnection, interpret, runTool, sshCommandFor, parseSshCommand, keyFileOf,
};
