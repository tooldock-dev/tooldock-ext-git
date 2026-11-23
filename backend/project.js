'use strict';
/**
 * 專案交換格式 git-tool.project v1（schema：exchange/project.v1.schema.json）。
 *
 * 用途：
 * - 同一台電腦上，在 Git 工具與其他工具（例如程式碼編輯器）之間互相開啟專案：帶 path。
 * - 分享給別人：存成 .tdx，只帶遠端網址與分支，不帶本機路徑。
 *
 * 交換包可能來自不可信的 .tdx 檔，所以接收時一律重新驗證；網址去掉帳號密碼，只接受網路上的遠端。
 */
const path = require('path');

const TYPE = 'git-tool.project';
const VERSION = 1;
const MAX = { name: 100, url: 2048, branch: 255, file: 1024, remotes: 20 };

/** 去掉網址中的帳號密碼：https://user:token@host/x → https://host/x；ssh://git:pw@host → ssh://git@host */
function stripCredentials(url) {
  const u = String(url || '').trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)(.*)$/i.exec(u);
  if (!m) return u;
  const scheme = m[1].toLowerCase();
  if (scheme === 'ssh://' || scheme === 'git+ssh://' || scheme === 'ssh+git://') {
    // SSH 的使用者名稱（git@）不是機密，保留；密碼去掉
    const user = m[2].slice(0, -1).split(':')[0];
    return `${m[1]}${user ? `${user}@` : ''}${m[3]}`;
  }
  return `${m[1]}${m[3]}`;
}

/**
 * 能分享、也能從交換包接收的遠端網址：https、http、ssh、git，以及 scp 形式（git@host:path）。
 * 本機路徑、file://、ext:: 等一律不接受（.tdx 檔可能來自別人，不能讓它指向本機或執行指令）。
 */
function isNetworkUrl(url) {
  const u = String(url || '').trim();
  // eslint-disable-next-line no-control-regex
  if (!u || u.length > MAX.url || u.startsWith('-') || /[\s\0-\x1f]/.test(u)) return false;
  if (/^(https?|ssh|git|git\+ssh|ssh\+git):\/\/[^/\s]+/i.test(u)) return true;
  // scp 形式：[user@]host:path，host 至少兩個字元（避免把 Windows 磁碟機代號 C:\ 當成主機）
  return /^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]{2,}:(?!\/\/)[^\\]+$/.test(u) && !/^[A-Za-z]:[\\/]/.test(u);
}

/** 遠端清單（git remote -v 的解析結果）→ 可以分享的 { name, url }，origin 排第一 */
function shareableRemotes(remotes) {
  const out = [];
  const seen = new Set();
  for (const r of remotes || []) {
    if (!r || !r.name || seen.has(r.name)) continue;
    const url = stripCredentials(r.url);
    if (!isNetworkUrl(url)) continue;
    seen.add(r.name);
    out.push({ name: String(r.name).slice(0, MAX.name), url });
  }
  out.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
  return out.slice(0, MAX.remotes);
}

/**
 * 建立 payload。forFile 為 true（存成 .tdx 給別人）時不帶本機路徑，而且必須有遠端。
 */
function buildPayload({ name, root, remotes, branch, file, line }, { forFile = false } = {}) {
  const p = { name: String(name || (root ? path.basename(root) : '') || '專案').slice(0, MAX.name) };
  if (!forFile && root) p.path = path.resolve(root);
  const rs = shareableRemotes(remotes);
  if (rs.length) p.remotes = rs;
  if (branch && typeof branch === 'string' && branch.length <= MAX.branch) p.branch = branch;
  if (!forFile && file) {
    p.file = String(file);
    if (Number.isInteger(line) && line > 0) p.line = line;
  }
  if (forFile && !p.remotes) {
    const e = new Error('這個儲存庫沒有設定網路上的遠端（例如 GitHub），別人無法取得內容。請先新增遠端並推送。');
    e.code = 'NO_REMOTE';
    throw e;
  }
  return p;
}

/**
 * 驗證並整理收到的 payload。origin 為 'file'（.tdx 檔）時忽略本機路徑，只用遠端。
 * 回傳 { name, path, remotes, branch, file, line }；不合法時丟出例外（訊息給使用者看）。
 */
function parsePayload(payload, { origin = 'share' } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('交換包內容不正確');
  const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
  const out = { name: str(payload.name, MAX.name) || '', path: null, remotes: [], branch: null, file: null, line: null };
  if (origin !== 'file' && payload.path !== undefined) {
    const p = str(payload.path, 4096);
    if (!p || !path.isAbsolute(p)) throw new Error('專案路徑必須是絕對路徑');
    out.path = path.resolve(p);
  }
  if (payload.remotes !== undefined) {
    if (!Array.isArray(payload.remotes)) throw new Error('remotes 必須是陣列');
    out.remotes = shareableRemotes(payload.remotes.filter((r) => r && typeof r.url === 'string' && typeof r.name === 'string'));
  }
  if (payload.branch !== undefined) {
    const b = str(payload.branch, MAX.branch);
    // 和 git check-ref-format 相同的基本限制；真正建立前 git 還會再檢查
    if (b && !b.startsWith('-') && !/[\s~^:?*[\\\0-\x1f]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\./.test(b)) out.branch = b;
  }
  if (out.path && payload.file !== undefined) {
    const f = str(payload.file, MAX.file);
    if (f) {
      const abs = path.resolve(out.path, f);
      const rel = path.relative(out.path, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        out.file = rel.split(path.sep).join('/');
        if (Number.isInteger(payload.line) && payload.line > 0) out.line = payload.line;
      }
    }
  }
  if (!out.path && !out.remotes.length) {
    throw new Error(origin === 'file' ? '交換檔沒有可以複製的遠端網址' : '交換包沒有專案路徑，也沒有遠端網址');
  }
  if (!out.name) out.name = out.path ? path.basename(out.path) : repoName(out.remotes[0].url);
  return out;
}

function repoName(url) {
  const s = String(url || '').trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  return s.split(/[\\/:]/).pop() || '專案';
}

/** 比較兩個遠端網址是否指向同一個儲存庫（忽略帳密、結尾的 .git 與 /、主機大小寫、https 與 ssh 的差異） */
function sameRemote(a, b) {
  const norm = (u) => {
    let s = stripCredentials(u).replace(/[\\/]+$/, '').replace(/\.git$/i, '');
    let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
    if (!m) m = /^(?:[^@]+@)?([^:]+):(.*)$/.exec(s);
    if (!m) return s;
    return `${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '')}`;
  };
  return !!a && !!b && norm(a) === norm(b);
}

module.exports = { TYPE, VERSION, stripCredentials, isNetworkUrl, shareableRemotes, buildPayload, parsePayload, sameRemote, repoName };
