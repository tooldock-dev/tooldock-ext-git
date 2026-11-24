'use strict';
/**
 * 儲存庫操作：每個函式第一個參數是 createRunner() 建立的 git 執行器，第二個是儲存庫根目錄（top）。
 * 會修改儲存庫的操作由呼叫端（backend/index.js）排隊，一次只執行一個。
 */
const fs = require('fs');
const path = require('path');
const G = require('./git');
const C = require('../ui/git-core');

const { safeRel, safePaths, safeRef, chunk } = G;

/* ───────────── 儲存庫 ───────────── */

/** 資料夾所在儲存庫的根目錄；不是儲存庫時回傳 null */
async function topLevel(git, dir) {
  try {
    const top = (await git.text(['rev-parse', '--show-toplevel'], dir, { quiet: true })).trim();
    return top ? path.resolve(top) : null;
  } catch (err) {
    if (err.code === 'NO_GIT' || err.code === 'UNSAFE') throw err;
    return null;
  }
}

/** 分享專案用的摘要：遠端與目前分支（不跑 status，大型儲存庫也很快） */
async function describe(git, top) {
  const remotes = G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true }));
  let branch = '';
  try { branch = (await git.text(['symbolic-ref', '--short', '-q', 'HEAD'], top, { quiet: true })).trim(); } catch { /* 分離的 HEAD */ }
  return { remotes, branch };
}

async function gitDir(git, top) {
  return path.resolve(top, (await git.text(['rev-parse', '--git-dir'], top, { quiet: true })).trim());
}

/** 進行中的合併／重定基底／揀選／還原 */
function opState(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return '';
}

function mergeMessage(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'MERGE_MSG'), 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
  } catch {
    return '';
  }
}

async function status(git, top) {
  const dir = await gitDir(git, top);
  const st = G.parseStatus((await git(['status', '--porcelain=v1', '-z', '-b', '-uall'], top, { quiet: true })).stdout);
  let head = null;
  if (!st.noCommits) {
    try {
      const [hash, short, subject] = (await git.text(['log', '-1', '--format=%H%x1f%h%x1f%s'], top, { quiet: true })).trim().split('\x1f');
      head = { hash, short, subject };
    } catch { /* 忽略 */ }
  }
  const remotes = G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true }));
  const state = opState(dir);
  const g = G.group(st.entries);
  // 假設未變更的檔案：git ls-files -v 以小寫字母標示
  let assumed = [];
  try {
    assumed = (await git.text(['ls-files', '-v', '-z'], top, { quiet: true })).split('\0')
      .filter((r) => /^[a-z] /.test(r)).map((r) => ({ path: r.slice(2), status: 'h', label: '假設未變更' }));
  } catch { /* 忽略 */ }
  return {
    top,
    gitDir: dir,
    branch: st.detached ? '' : st.branch,
    detached: st.detached,
    upstream: st.upstream,
    upstreamGone: st.gone,
    ahead: st.ahead,
    behind: st.behind,
    noCommits: st.noCommits,
    head,
    remotes,
    state,
    mergeMessage: state ? mergeMessage(dir) : '',
    ...g,
    assumed,
  };
}

/* ───────────── 比對內容 ───────────── */

async function blob(git, top, rev, rel) {
  try {
    return { exists: true, ...G.decode((await git(['cat-file', 'blob', `${rev}:${rel}`], top, { quiet: true })).stdout, rel) };
  } catch {
    return { exists: false, text: '' };
  }
}

/**
 * 工作區的比對兩側：
 *   staged     HEAD（重新命名時為原路徑）↔ 暫存區
 *   unstaged   暫存區 ↔ 工作目錄
 *   untracked  （無）↔ 工作目錄
 *   conflict   HEAD ↔ 工作目錄（含衝突標記）
 */
async function diffSides(git, top, { area, path: p, orig }) {
  const rel = safeRel(top, p);
  const o = orig ? safeRel(top, orig) : '';
  let left, right, leftLabel, rightLabel;
  if (area === 'staged') {
    left = await blob(git, top, 'HEAD', o || rel);
    right = await blob(git, top, '', rel);
    leftLabel = o ? `HEAD：${o}` : 'HEAD';
    rightLabel = '已暫存';
  } else if (area === 'unstaged') {
    left = await blob(git, top, '', rel);
    if (!left.exists) left = await blob(git, top, 'HEAD', rel);
    right = G.readWorking(top, rel);
    leftLabel = '已暫存／HEAD';
    rightLabel = '工作目錄';
  } else if (area === 'untracked') {
    left = { exists: false, text: '' };
    right = G.readWorking(top, rel);
    leftLabel = '（新檔案）';
    rightLabel = '工作目錄';
  } else if (area === 'conflict') {
    left = await blob(git, top, 'HEAD', rel);
    right = G.readWorking(top, rel);
    leftLabel = 'HEAD';
    rightLabel = '工作目錄（含衝突標記）';
  } else {
    throw new Error(`未知的比對區域：${area}`);
  }
  return { path: rel, left: { ...left, label: leftLabel }, right: { ...right, label: rightLabel } };
}

/* ───────────── 歷史與線圖 ───────────── */

/**
 * 線圖的提交。search：{ mode, text } 在 git 端搜尋全部歷史：
 *   content  檔案內容中出現次數改變的提交（-S）　message  提交訊息　author  作者名稱或 email
 */
async function log(git, top, { limit = 300, skip = 0, all = true, search } = {}) {
  const n = Math.max(1, Math.min(5000, Number(limit) || 300));
  const args = ['log', '-z', `--format=${G.LOG_FORMAT}`, '--decorate=full', '--date-order', `--max-count=${n + 1}`, `--skip=${Math.max(0, Number(skip) || 0)}`];
  if (search && String(search.text || '').trim()) {
    const t = String(search.text).trim();
    // eslint-disable-next-line no-control-regex
    if (/[\0\n\r]/.test(t)) throw new Error('搜尋文字不能換行');
    if (search.mode === 'content') args.push(`-S${t}`);
    else if (search.mode === 'message') args.push(`--grep=${t}`, '--fixed-strings', '--regexp-ignore-case');
    else if (search.mode === 'author') args.push(`--author=${t}`, '--fixed-strings', '--regexp-ignore-case');
    else throw new Error('不支援的搜尋方式');
  }
  if (all) args.push('--branches', '--remotes', '--tags');
  args.push('HEAD', '--');
  let text;
  try {
    text = await git.text(args, top, { quiet: true });
  } catch (err) {
    // 還沒有任何提交
    if (/unknown revision|bad revision 'HEAD'|bad default revision|does not have any commits/i.test(err.stderr || '')) return { commits: [], more: false };
    throw err;
  }
  const commits = G.parseLog(text);
  const more = commits.length > n;
  return { commits: commits.slice(0, n), more };
}

const HASH = /^[0-9a-f]{4,64}$/i;
function safeHash(h) {
  if (typeof h !== 'string' || !HASH.test(h)) throw new Error('提交編號不正確');
  return h;
}

async function commitInfo(git, top, hash) {
  safeHash(hash);
  const text = await git.text(['show', '-s', '--decorate=full', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B', hash, '--'], top, { quiet: true });
  const [full, parents, author, email, at, committer, cemail, ct, refs, ...body] = text.split('\x1f');
  const ps = parents ? parents.trim().split(' ').filter(Boolean) : [];
  // 合併提交與第一個父提交比較
  const args = ps.length
    ? ['diff', '--name-status', '-z', '-M', ps[0], full, '--']
    : ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', full, '--'];
  const files = G.parseNameStatus(await git.text(args, top, { quiet: true }));
  return {
    hash: full,
    parents: ps,
    author, email, time: Number(at) * 1000,
    committer, committerEmail: cemail, commitTime: Number(ct) * 1000,
    refs: G.parseRefs(refs),
    message: body.join('\x1f').replace(/\s+$/, ''),
    files,
  };
}

/** 某個提交中一個檔案的比對兩側（與第一個父提交比較） */
async function commitDiff(git, top, { hash, parent, path: p, orig }) {
  safeHash(hash);
  if (parent) safeHash(parent);
  const rel = safeRel(top, p);
  const o = orig ? safeRel(top, orig) : '';
  const left = parent ? await blob(git, top, parent, o || rel) : { exists: false, text: '' };
  const right = await blob(git, top, hash, rel);
  return {
    path: rel,
    left: { ...left, label: parent ? `${parent.slice(0, 7)}${o ? `：${o}` : ''}` : '（無）' },
    right: { ...right, label: hash.slice(0, 7) },
  };
}

/** 提交存成 patch 的內容（git format-patch -1 --stdout） */
async function formatPatch(git, top, { hash }) {
  safeHash(hash);
  return (await git(['format-patch', '-1', '--stdout', '--no-signature', hash, '--'], top, { quiet: true })).stdout;
}

/** 提交與目前工作目錄的差異（只含已追蹤的檔案） */
async function compareWorking(git, top, { hash }) {
  safeHash(hash);
  return G.parseNameStatus(await git.text(['diff', '--name-status', '-z', '-M', hash, '--'], top, { quiet: true }));
}

async function compareWorkingDiff(git, top, { hash, path: p, orig }) {
  safeHash(hash);
  const rel = safeRel(top, p);
  const o = orig ? safeRel(top, orig) : '';
  const left = await blob(git, top, hash, o || rel);
  const right = G.readWorking(top, rel);
  return { path: rel, left: { ...left, label: `${hash.slice(0, 7)}${o ? `：${o}` : ''}` }, right: { ...right, label: '工作目錄' } };
}

/* ───────────── 參照紀錄、比較、子模組、工作樹 ───────────── */

/** HEAD 的參照紀錄（reflog）：切換、提交、重設、重定基底……都會留下紀錄，可以用來找回不見的提交 */
async function reflog(git, top, { limit = 300 } = {}) {
  const n = Math.max(1, Math.min(2000, Number(limit) || 300));
  let text = '';
  try {
    text = await git.text(['log', '-g', '-z', `--max-count=${n}`, '--format=%H%x1f%gd%x1f%gs%x1f%ct%x1f%s', 'HEAD', '--'], top, { quiet: true });
  } catch { return []; }
  return text.split('\0').filter((r) => r.trim()).map((r) => {
    const [hash, ref, action, ct, subject] = r.replace(/^\n/, '').split('\x1f');
    return { hash, ref, action: action || '', time: Number(ct) * 1000, subject: subject || '' };
  });
}

/** 兩個提交之間變更的檔案（from → to） */
async function compareRange(git, top, { from, to }) {
  safeHash(from);
  safeHash(to);
  return G.parseNameStatus(await git.text(['diff', '--name-status', '-z', '-M', from, to, '--'], top, { quiet: true }));
}

/** 子模組：git submodule status --recursive */
async function submodules(git, top) {
  if (!fs.existsSync(path.join(top, '.gitmodules'))) return [];
  let text = '';
  try { text = await git.text(['-c', 'core.quotePath=false', 'submodule', 'status', '--recursive'], top, { quiet: true }); } catch { return []; }
  const STATE = { ' ': 'ok', '-': 'uninit', '+': 'changed', U: 'conflict' };
  return text.split('\n').filter(Boolean).map((l) => {
    const m = /^([ +\-U])([0-9a-f]+) (.+?)(?: \((.*)\))?$/.exec(l);
    return m ? { state: STATE[m[1]] || 'ok', hash: m[2], path: m[3], describe: m[4] || '' } : null;
  }).filter(Boolean);
}

async function submoduleUpdate(git, top, { path: p } = {}, net) {
  const args = ['submodule', 'update', '--init', '--recursive', '--progress'];
  if (p) args.push('--', safeRel(top, p));
  await git(args, top, net);
}

/** 工作樹：git worktree list --porcelain */
async function worktrees(git, top) {
  let text = '';
  try { text = await git.text(['worktree', 'list', '--porcelain'], top, { quiet: true }); } catch { return []; }
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const w = {};
    for (const l of block.split('\n')) {
      const sp = l.indexOf(' ');
      const k = sp < 0 ? l : l.slice(0, sp), v = sp < 0 ? '' : l.slice(sp + 1);
      if (k === 'worktree') w.path = path.resolve(v);
      else if (k === 'HEAD') w.hash = v;
      else if (k === 'branch') w.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'detached') w.detached = true;
      else if (k === 'bare') w.bare = true;
      else if (k === 'locked') w.locked = true;
      else if (k === 'prunable') w.prunable = true;
    }
    if (w.path) out.push({ ...w, main: !out.length, current: path.resolve(top) === w.path });
  }
  return out;
}

/** 新增工作樹：branch 為既有分支；newBranch 為要建立的新分支（從 from 或 HEAD） */
async function addWorktree(git, top, { dir, branch, newBranch, from }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('請選擇工作樹的資料夾');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} 已經存在而且不是空的`);
  if (newBranch) {
    await validBranchName(git, top, newBranch);
    await git(['worktree', 'add', '-b', newBranch, dir, ...(from ? [safeRef(from, '起點')] : [])], top);
  } else {
    safeRef(branch, '分支名稱');
    await git(['worktree', 'add', dir, branch], top);
  }
  return path.resolve(dir);
}

async function removeWorktree(git, top, { dir, force = false }) {
  const list = await worktrees(git, top);
  const w = list.find((x) => x.path === path.resolve(String(dir || '')));
  if (!w) throw new Error('找不到這個工作樹');
  if (w.main) throw new Error('不能移除主要的工作樹');
  await git(['worktree', 'remove', ...(force ? ['--force'] : []), w.path], top);
}

/* ───────────── 檔案歷史與逐行追溯 ───────────── */

/** 一個檔案的提交歷史（跟著重新命名）：每筆附上當時的路徑與變更類型 */
async function fileHistory(git, top, { path: p, limit = 500 }) {
  const rel = safeRel(top, p);
  const n = Math.max(1, Math.min(5000, Number(limit) || 500));
  const text = await git.text(['-c', 'core.quotePath=false', 'log', '--follow', `--max-count=${n}`, '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s', '--name-status', '-M', '--', rel], top, { quiet: true });
  const out = [];
  for (const rec of text.split('\x1e')) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split('\n');
    const [hash, parents, author, email, at, subject] = head.split('\x1f');
    const line = rest.find((l) => /^[A-Z]\d*\t/.test(l)) || '';
    const parts = line.split('\t');
    const status = (parts[0] || 'M')[0];
    const item = { hash, parents: parents ? parents.split(' ') : [], author, email, time: Number(at) * 1000, subject: subject || '', status, path: parts[parts.length - 1] || rel };
    if ((status === 'R' || status === 'C') && parts.length >= 3) item.orig = parts[1];
    out.push(item);
  }
  return out;
}

/** git blame --porcelain：每一行的提交與內容；rev 為空時以工作目錄為準（未提交的行 hash 為 0） */
async function blame(git, top, { path: p, rev = '' }) {
  const rel = safeRel(top, p);
  if (rev) safeHash(rev);
  const buf = (await git(['blame', '--porcelain', ...(rev ? [rev] : []), '--', rel], top, { quiet: true })).stdout;
  if (buf.includes(0)) throw new Error('二進位檔案無法逐行追溯');
  const commits = {};
  const lines = [];
  let cur = null;
  for (const l of buf.toString('utf8').split('\n')) {
    if (l.startsWith('\t')) { lines.push({ hash: cur, text: l.slice(1).replace(/\r$/, '') }); continue; }
    const m = /^([0-9a-f]{40,64}) \d+ \d+/.exec(l);
    if (m) { cur = m[1]; if (!commits[cur]) commits[cur] = { hash: cur }; continue; }
    const sp = l.indexOf(' ');
    if (!cur || sp < 0) continue;
    const k = l.slice(0, sp), v = l.slice(sp + 1);
    if (k === 'author') commits[cur].author = v;
    else if (k === 'author-time') commits[cur].time = Number(v) * 1000;
    else if (k === 'summary') commits[cur].summary = v;
  }
  return { path: rel, lines, commits };
}

/* ───────────── 暫存與提交 ───────────── */

async function stage(git, top, paths) {
  for (const part of chunk(safePaths(top, paths))) await git(['add', '-A', '--', ...part], top);
}

async function unstage(git, top, paths, { noCommits } = {}) {
  for (const part of chunk(safePaths(top, paths))) {
    if (noCommits) await git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...part], top);
    else await git(['reset', '-q', 'HEAD', '--', ...part], top);
  }
}

async function stageAll(git, top) {
  await git(['add', '-A'], top);
}

async function unstageAll(git, top, { noCommits } = {}) {
  if (noCommits) await git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.'], top);
  else await git(['reset', '-q'], top);
}

/* ───────────── 逐區塊、逐行暫存 ───────────── */

/** 檔案在暫存區（rev 為空）或某個提交中的權限；找不到時回傳空字串 */
async function fileMode(git, top, rev, rel) {
  try {
    const text = rev
      ? await git.text(['ls-tree', rev, '--', rel], top, { quiet: true })
      : await git.text(['ls-files', '-s', '--', rel], top, { quiet: true });
    const m = text.match(/^(\d{6}) /);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

const withBom = (text, bom) => {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
};

/**
 * 只暫存、取消暫存或捨棄一部分的行：
 *   area     'unstaged' | 'untracked'（stage、discard）或 'staged'（unstage）
 *   del/add  選取的刪除行（左側行索引）與新增行（右側行索引），對應 diffSides 的兩側與 GitCore.diffLines 的結果
 *   check    畫面看到的兩側內容雜湊（GitCore.textHash），檔案在這段期間被改過時拒絕
 * 選取涵蓋全部變更時改用整個檔案的操作。寫入暫存區時保留檔案權限與 BOM，行尾以寫入的那一側為準。
 */
async function partial(git, top, { area, action, path: p, del = [], add = [], check }) {
  const rel = safeRel(top, p);
  const ok = { unstaged: ['stage', 'discard'], untracked: ['stage', 'discard'], staged: ['unstage'] }[area];
  if (!ok || !ok.includes(action)) throw new Error('不支援的操作');
  if (!Array.isArray(del) || !Array.isArray(add) || ![...del, ...add].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('選取的行不正確');
  if (!del.length && !add.length) throw new Error('沒有選取任何變更');
  const st = await status(git, top);
  const entry = (st[area] || []).find((e) => e.path === rel);
  if (!entry) throw new Error('檔案的狀態已經改變，請重新整理');
  if (area === 'staged' && entry.orig) throw new Error('重新命名的檔案只能整個取消暫存');
  const d = await diffSides(git, top, { area, path: rel });
  const L = d.left, R = d.right;
  if (L.binary || R.binary || L.tooLarge || R.tooLarge || L.readOnly || R.readOnly) throw new Error('這個檔案不能逐行操作（二進位、過大或不是 UTF-8）');
  if (check !== `${C.textHash(L.text)}:${C.textHash(R.text)}`) throw new Error('檔案在這段期間被修改過，請重新整理後再選取');

  if (C.coversAll(L.text, R.text, { del, add }) && !(area === 'untracked' && action === 'discard')) {
    if (action === 'stage') await stage(git, top, [rel]);
    else if (action === 'unstage') await unstage(git, top, [rel], { noCommits: st.noCommits });
    else await discard(git, top, { tracked: [rel] });
    return { whole: true };
  }

  if (action === 'discard') {
    const text = C.applyPartial(L.text, R.text, { del, add, invert: true, target: 'b' });
    fs.writeFileSync(path.join(top, rel), withBom(text, R.bom));
    return { whole: false };
  }

  // 寫入暫存區：暫存以左側（暫存區）為準；取消暫存以右側（暫存區）為準
  const target = action === 'stage' ? 'a' : 'b';
  const text = C.applyPartial(L.text, R.text, { del, add, invert: action === 'unstage', target });
  const own = target === 'a' ? L : R;
  const bom = own.exists ? own.bom : (L.bom || R.bom);
  let mode = await fileMode(git, top, '', rel) || await fileMode(git, top, 'HEAD', rel);
  if (!mode) {
    try { mode = fs.statSync(path.join(top, rel)).mode & 0o111 ? '100755' : '100644'; } catch { mode = '100644'; }
  }
  if (mode !== '100644' && mode !== '100755') throw new Error('這個檔案不能逐行操作（符號連結或子模組）');
  // 暫存時套用 git 的轉換（core.autocrlf 等），和 git add 的結果一致；取消暫存的內容本來就來自儲存庫
  const args = action === 'stage' ? ['hash-object', '-w', `--path=${rel}`, '--stdin'] : ['hash-object', '-w', '--no-filters', '--stdin'];
  const sha = (await git.text(args, top, { input: withBom(text, bom), quiet: true })).trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('無法寫入暫存區');
  await git(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], top);
  return { whole: false };
}

/** 加入 .gitignore（儲存庫根目錄）；已經有同一行時不重複 */
function addIgnore(top, { pattern }) {
  const pat = String(pattern || '').trim();
  // eslint-disable-next-line no-control-regex
  if (!pat || /[\0-\x1f]/.test(pat)) throw new Error('忽略規則不正確');
  const f = path.join(top, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* 還沒有 .gitignore */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === pat)) return { added: false };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(f, `${text}${text && !/\n$/.test(text) ? eol : ''}${pat}${eol}`);
  return { added: true };
}

/** 捨棄變更：已追蹤的檔案還原成暫存區的內容；未追蹤的檔案刪除 */
async function discard(git, top, { tracked = [], untracked = [] }) {
  if (tracked.length) for (const part of chunk(safePaths(top, tracked))) await git(['checkout', '-q', '--', ...part], top);
  if (untracked.length) for (const part of chunk(safePaths(top, untracked))) await git(['clean', '-f', '-q', '--', ...part], top);
}

async function commit(git, top, { message, amend = false, noEdit = false, noVerify = false, signoff = false }) {
  const msg = String(message || '').replace(/\r\n?/g, '\n').trim();
  const args = ['commit', '--cleanup=strip'];
  if (amend) args.push('--amend');
  if (noVerify) args.push('--no-verify');
  if (signoff) args.push('--signoff');
  if (!msg) {
    if (!amend && !noEdit) throw new Error('請輸入提交訊息');
    args.push('--no-edit');
    await git(args, top);
  } else {
    args.push('-F', '-');
    await git(args, top, { input: `${msg}\n` });
  }
  return (await git.text(['log', '-1', '--format=%h %s'], top, { quiet: true })).trim();
}

async function identity(git, top) {
  const get = async (k) => {
    try { return (await git.text(['config', '--get', k], top, { quiet: true })).trim(); } catch { return ''; }
  };
  return { name: await get('user.name'), email: await get('user.email') };
}

async function setIdentity(git, top, { name, email, global = true }) {
  const n = String(name || '').trim();
  const e = String(email || '').trim();
  if (!n || !e) throw new Error('名稱與 email 都要填寫');
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new Error('email 格式不正確');
  const scope = global ? ['--global'] : [];
  await git(['config', ...scope, 'user.name', n], top);
  await git(['config', ...scope, 'user.email', e], top);
}

/* ───────────── SSH 金鑰（core.sshCommand） ───────────── */

/** 儲存庫與全域的 core.sshCommand；top 為 null 時只讀全域 */
async function sshCommands(git, top) {
  const get = async (scope, cwd) => {
    try { return (await git.text(['config', scope, '--get', 'core.sshCommand'], cwd, { quiet: true })).trim(); } catch { return ''; }
  };
  return { local: top ? await get('--local', top) : '', global: await get('--global', top || undefined) };
}

/** 設定（value）或移除（value 為空）core.sshCommand；scope：local（這個儲存庫）或 global */
async function setSshCommand(git, top, { scope, value }) {
  if (scope !== 'local' && scope !== 'global') throw new Error('scope 不正確');
  if (scope === 'local' && !top) throw new Error('請先選擇儲存庫');
  const v = String(value || '').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f]/.test(v)) throw new Error('指令不能換行');
  const cwd = top || undefined;
  if (v) { await git(['config', `--${scope}`, 'core.sshCommand', v], cwd); return; }
  try { await git(['config', `--${scope}`, '--unset-all', 'core.sshCommand'], cwd, { quiet: true }); } catch { /* 本來就沒有設定 */ }
}

/* ───────────── 分支 ───────────── */

async function branches(git, top) {
  const text = await git.text(['for-each-ref', `--format=${G.REF_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags'], top, { quiet: true });
  return G.parseBranches(text);
}

async function validBranchName(git, top, name) {
  safeRef(name, '分支名稱');
  try {
    await git(['check-ref-format', '--branch', name], top, { quiet: true });
  } catch {
    throw new Error(`分支名稱不合法：${name}（不能有空白、~ ^ : ? * [ \\，也不能以 / 或 . 結尾）`);
  }
  return name;
}

/**
 * 切換：
 *   { branch }           本機分支
 *   { remote: 'o/x' }    遠端分支：本機有同名分支就切過去，沒有就建立並追蹤
 *   { commit }           分離的 HEAD
 */
async function checkout(git, top, { branch, remote, commit: hash }) {
  if (branch) {
    safeRef(branch, '分支名稱');
    await git(['checkout', '-q', branch, '--'], top);
    return branch;
  }
  if (remote) {
    safeRef(remote, '遠端分支');
    const remotes = G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true })).map((r) => r.name);
    const rn = remotes.filter((r) => remote.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (!rn) throw new Error(`找不到遠端分支 ${remote}`);
    const local = remote.slice(rn.length + 1);
    const list = await branches(git, top);
    if (list.local.some((b) => b.name === local)) {
      await git(['checkout', '-q', local, '--'], top);
    } else {
      await validBranchName(git, top, local);
      await git(['checkout', '-q', '-b', local, '--track', `refs/remotes/${remote}`], top);
    }
    return local;
  }
  if (hash) {
    safeHash(hash);
    await git(['checkout', '-q', '--detach', hash, '--'], top);
    return hash.slice(0, 7);
  }
  throw new Error('沒有指定要切換到哪裡');
}

async function createBranch(git, top, { name, from, checkout: co = true }) {
  await validBranchName(git, top, name);
  const start = from ? [safeRef(from, '起點')] : [];
  if (co) await git(['checkout', '-q', '-b', name, ...start], top);
  else await git(['branch', name, ...start], top);
}

async function deleteBranch(git, top, { name, force = false }) {
  safeRef(name, '分支名稱');
  await git(['branch', force ? '-D' : '-d', name], top);
}

async function renameBranch(git, top, { from, to }) {
  safeRef(from, '分支名稱');
  await validBranchName(git, top, to);
  await git(['branch', '-m', from, to], top);
}

async function deleteRemoteBranch(git, top, { remote: full }, net) {
  safeRef(full, '遠端分支');
  const remotes = G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true })).map((r) => r.name);
  const rn = remotes.filter((r) => full.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (!rn) throw new Error(`找不到遠端 ${full}`);
  await git(['push', '--progress', rn, '--delete', full.slice(rn.length + 1)], top, net);
}

async function createTag(git, top, { name, at, message }) {
  safeRef(name, '標籤名稱');
  try { await git(['check-ref-format', `refs/tags/${name}`], top, { quiet: true }); } catch { throw new Error(`標籤名稱不合法：${name}`); }
  const target = at ? [safeHash(at)] : [];
  const msg = String(message || '').trim();
  if (msg) await git(['tag', '-a', name, '-F', '-', ...target], top, { input: `${msg}\n` });
  else await git(['tag', name, ...target], top);
}

async function deleteTag(git, top, { name }) {
  safeRef(name, '標籤名稱');
  await git(['tag', '-d', name], top);
}

async function remoteNames(git, top) {
  return G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true }));
}

/** 推送一個標籤，或 name 為空時推送全部標籤 */
async function pushTag(git, top, { remote, name, force = false }, net) {
  const rn = pickRemote(await remoteNames(git, top), remote);
  const args = ['push', '--progress'];
  if (force) args.push('--force');
  if (name) {
    safeRef(name, '標籤名稱');
    await git([...args, rn, `refs/tags/${name}:refs/tags/${name}`], top, net);
  } else {
    await git([...args, rn, '--tags'], top, net);
  }
  return { remote: rn };
}

async function deleteRemoteTag(git, top, { remote, name }, net) {
  safeRef(name, '標籤名稱');
  const rn = pickRemote(await remoteNames(git, top), remote);
  await git(['push', '--progress', rn, '--delete', `refs/tags/${name}`], top, net);
  return { remote: rn };
}

/** 合併到目前分支；有衝突時回傳 { conflict: true } 而不是丟出錯誤 */
async function merge(git, top, { ref, noFF = false }) {
  safeRef(ref, '分支');
  const args = ['merge', '--no-edit'];
  if (noFF) args.push('--no-ff');
  args.push(ref);
  return withConflict(git, top, () => git(args, top));
}

async function cherryPick(git, top, { hash }) {
  safeHash(hash);
  return withConflict(git, top, () => git(['cherry-pick', hash], top));
}

async function revert(git, top, { hash }) {
  safeHash(hash);
  return withConflict(git, top, () => git(['revert', '--no-edit', hash], top));
}

/** 重設目前分支到指定的提交：soft（保留暫存）、mixed（保留檔案）、hard（捨棄全部變更） */
async function reset(git, top, { hash, mode }) {
  safeHash(hash);
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('重設方式不正確');
  await git(['reset', `--${mode}`, '-q', hash, '--'], top);
}

/* ───────────── 重定基底 ───────────── */

/** sh 的單引號字串（git 以 sh 執行編輯器與 exec，Windows 上是 Git 附帶的 sh） */
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function isAncestor(git, top, a, b) {
  try { await git(['merge-base', '--is-ancestor', a, b], top, { quiet: true }); return true; } catch { return false; }
}

/** 把目前分支重定基底到 onto（分支名稱或提交） */
async function rebaseOnto(git, top, { onto }) {
  safeRef(onto, '目標');
  const st = await status(git, top);
  if (st.detached) throw new Error('目前不在任何分支上（分離的 HEAD），無法重定基底');
  if (st.state) throw new Error('有進行中的合併，請先完成或中止');
  return withConflict(git, top, () => git(['rebase', onto], top, { env: { GIT_EDITOR: 'true' } }));
}

/** 互動式重定基底的提交清單：base（不含）之後到 HEAD，由舊到新 */
async function rebaseList(git, top, { base }) {
  safeHash(base);
  if (!await isAncestor(git, top, base, 'HEAD')) throw new Error('這個提交不在目前分支的歷史中');
  const merges = (await git.text(['rev-list', '--merges', `${base}..HEAD`], top, { quiet: true })).trim();
  if (merges) throw new Error('這段歷史中有合併提交，無法互動式重定基底');
  const text = await git.text(['log', '--reverse', '-z', '--format=%H%x1f%h%x1f%an%x1f%at%x1f%B', `${base}..HEAD`, '--'], top, { quiet: true });
  return text.split('\0').filter((r) => r.trim()).map((r) => {
    const [hash, short, author, at, message] = r.replace(/^\n/, '').split('\x1f');
    return { hash, short, author, time: Number(at) * 1000, message: String(message || '').replace(/\s+$/, ''), subject: String(message || '').split('\n')[0] };
  });
}

const REBASE_ACTIONS = new Set(['pick', 'reword', 'squash', 'fixup', 'drop']);

/**
 * 互動式重定基底：steps 依新的順序列出 base 之後的每個提交 { hash, action, message }。
 *   pick 保留　reword 改訊息（message）　squash 併入上一個提交（message 為合併後的訊息，空白時合併兩者的訊息）
 *   fixup 併入上一個提交、捨棄自己的訊息　drop 移除
 * 以 GIT_SEQUENCE_EDITOR 寫入事先準備好的待辦清單；改訊息以 exec git commit --amend -F 完成，不需要互動的編輯器。
 */
async function interactiveRebase(git, top, { base, steps }) {
  const list = await rebaseList(git, top, { base });
  if (!Array.isArray(steps) || steps.length !== list.length) throw new Error('提交清單已經改變，請重新開啟');
  const known = new Set(list.map((c) => c.hash));
  const seen = new Set();
  for (const s of steps) {
    if (!s || !known.has(s.hash) || seen.has(s.hash)) throw new Error('提交清單已經改變，請重新開啟');
    if (!REBASE_ACTIONS.has(s.action)) throw new Error(`不支援的動作：${s.action}`);
    seen.add(s.hash);
  }
  const kept = steps.filter((s) => s.action !== 'drop');
  if (kept.length && (kept[0].action === 'squash' || kept[0].action === 'fixup')) throw new Error('第一個保留的提交不能併入上一個提交（squash／fixup）');
  const st = await status(git, top);
  if (st.detached) throw new Error('目前不在任何分支上（分離的 HEAD），無法重定基底');
  if (st.state) throw new Error('有進行中的合併，請先完成或中止');

  const dir = path.join(await gitDir(git, top), 'tooldock-rebase');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const gitBin = git.bin() || 'git';
  const lines = [];
  steps.forEach((s, i) => {
    const msg = String(s.message || '').replace(/\r\n?/g, '\n').trim();
    const amend = () => {
      const f = path.join(dir, `msg-${i}.txt`);
      fs.writeFileSync(f, `${msg}\n`);
      lines.push(`exec ${shq(gitBin)} commit --amend --allow-empty --no-verify --cleanup=strip -F ${shq(f)}`);
    };
    if (s.action === 'reword') {
      if (!msg) throw new Error('改訊息時訊息不能是空的');
      lines.push(`pick ${s.hash}`);
      amend();
    } else if (s.action === 'squash') {
      lines.push(`squash ${s.hash}`);
      if (msg) amend();
    } else {
      lines.push(`${s.action} ${s.hash}`);
    }
  });
  const todo = path.join(dir, 'todo.txt');
  fs.writeFileSync(todo, `${lines.join('\n')}\n`);
  const env = { GIT_SEQUENCE_EDITOR: `cp ${shq(todo)}`, GIT_EDITOR: 'true' };
  return withConflict(git, top, () => git(['-c', 'rebase.missingCommitsCheck=ignore', '-c', 'rebase.abbreviateCommands=false', 'rebase', '-i', base], top, { env }));
}

/** 修改提交訊息：HEAD 直接修正（不帶入暫存的變更），較早的提交以互動式重定基底完成 */
async function reword(git, top, { hash, message }) {
  safeHash(hash);
  const msg = String(message || '').replace(/\r\n?/g, '\n').trim();
  if (!msg) throw new Error('請輸入提交訊息');
  const head = (await git.text(['rev-parse', 'HEAD'], top, { quiet: true })).trim();
  const full = (await git.text(['rev-parse', `${hash}^{commit}`], top, { quiet: true })).trim();
  if (full === head) {
    await git(['commit', '--amend', '--only', '--allow-empty', '--no-verify', '--cleanup=strip', '-F', '-'], top, { input: `${msg}\n` });
    return { conflict: false };
  }
  const parents = (await git.text(['rev-list', '--parents', '-n', '1', full], top, { quiet: true })).trim().split(' ').slice(1);
  if (parents.length !== 1) throw new Error('只能修改有一個父提交的提交訊息（不能是第一個提交或合併提交）');
  const list = await rebaseList(git, top, { base: parents[0] });
  return interactiveRebase(git, top, { base: parents[0], steps: list.map((c) => (c.hash === full ? { hash: c.hash, action: 'reword', message: msg } : { hash: c.hash, action: 'pick' })) });
}

/** 執行可能產生衝突的指令：結束後如果有衝突檔案，視為「需要解決衝突」而不是失敗 */
async function withConflict(git, top, fn) {
  try {
    const r = await fn();
    return { conflict: false, output: G.tail(`${r.stdout.toString('utf8')}\n${r.stderr}`) };
  } catch (err) {
    const st = await status(git, top).catch(() => null);
    if (st && st.conflict.length) return { conflict: true, files: st.conflict.map((c) => c.path), output: G.tail(`${err.stdout || ''}\n${err.stderr || ''}`) };
    throw err;
  }
}

/** 中止或繼續進行中的合併／重定基底／揀選／還原 */
async function abortOp(git, top) {
  const state = opState(await gitDir(git, top));
  if (!state) throw new Error('目前沒有進行中的合併');
  await git([state, '--abort'], top);
  return state;
}

async function continueOp(git, top, { message } = {}) {
  const state = opState(await gitDir(git, top));
  if (!state) throw new Error('目前沒有進行中的合併');
  const st = await status(git, top);
  if (st.conflict.length) throw new Error(`還有 ${st.conflict.length} 個衝突檔案沒有解決`);
  const env = { GIT_EDITOR: 'true' };
  if (state === 'merge') {
    await commit(git, top, { message, noEdit: true });
    return { state, conflict: false };
  }
  // 重定基底可能停在下一個有衝突的提交
  const r = await withConflict(git, top, () => git([state, '--continue'], top, { env }));
  return { state, ...r };
}

/* ───────────── 遠端 ───────────── */

function pickRemote(remotes, name) {
  if (name) {
    if (!remotes.some((r) => r.name === name)) throw new Error(`找不到遠端 ${name}`);
    return name;
  }
  if (!remotes.length) {
    const e = new Error('這個儲存庫還沒有設定遠端');
    e.code = 'NO_REMOTE';
    throw e;
  }
  return (remotes.find((r) => r.name === 'origin') || remotes[0]).name;
}

/** 擷取所有遠端；pruneTags 時也刪除遠端已經不存在的本機標籤 */
async function fetchAll(git, top, net, { pruneTags = false } = {}) {
  const remotes = G.parseRemotes(await git.text(['remote', '-v'], top, { quiet: true }));
  pickRemote(remotes);
  await git(['fetch', '--all', '--prune', ...(pruneTags ? ['--prune-tags'] : []), '--progress'], top, net);
}

/** 遠端有哪些標籤（git ls-remote --tags --refs） */
async function remoteTags(git, top, { remote }, net) {
  const rn = pickRemote(await remoteNames(git, top), remote);
  const text = await git.text(['ls-remote', '--tags', '--refs', rn], top, net);
  const tags = text.split('\n').map((l) => (/\trefs\/tags\/(.+)$/.exec(l) || [])[1]).filter(Boolean);
  return { remote: rn, tags };
}

/** 標示或取消「假設未變更」（git update-index --[no-]assume-unchanged） */
async function assumeUnchanged(git, top, { paths, on = true }) {
  for (const part of chunk(safePaths(top, paths))) await git(['update-index', on ? '--assume-unchanged' : '--no-assume-unchanged', '--', ...part], top);
}

/** 拉取；指定 remote 與 branch 時拉取那個遠端分支（不改變追蹤設定） */
async function pull(git, top, { mode = 'merge', remote, branch } = {}, net) {
  const st = await status(git, top);
  if (st.detached) throw new Error('目前不在任何分支上（分離的 HEAD），無法拉取');
  if (st.state) throw new Error('有進行中的合併，請先完成或中止');
  const args = ['pull', '--progress'];
  if (mode === 'rebase') args.push('--rebase', '--autostash');
  else if (mode === 'ff-only') args.push('--ff-only');
  else args.push('--no-rebase');
  if (remote && branch) {
    pickRemote(st.remotes, remote);
    safeRef(branch, '分支名稱');
    return withConflict(git, top, () => git([...args, remote, branch], top, net));
  }
  if (!st.upstream) {
    const remote = pickRemote(st.remotes);
    const name = st.branch;
    // 沒有追蹤分支時，如果遠端有同名分支就拉取它並設定追蹤
    const has = (await git.text(['ls-remote', '--heads', remote, `refs/heads/${name}`], top, net)).trim();
    if (!has) {
      const e = new Error(`目前分支 ${name} 還沒有對應的遠端分支，請先推送`);
      e.code = 'NO_UPSTREAM';
      throw e;
    }
    args.push(remote, name);
    const r = await withConflict(git, top, () => git(args, top, net));
    await git(['branch', `--set-upstream-to=${remote}/${name}`], top, { quiet: true }).catch(() => {});
    return r;
  }
  return withConflict(git, top, () => git(args, top, net));
}

/**
 * 推送目前分支。remote 與目前追蹤的遠端不同時改推到那個遠端並設定追蹤。
 * tags：分支推送成功後也推送所有標籤（git push <remote> --tags）。
 */
async function push(git, top, { remote: rn, force = false, tags = false } = {}, net) {
  const st = await status(git, top);
  if (st.detached) throw new Error('目前不在任何分支上（分離的 HEAD），無法推送');
  if (st.noCommits) throw new Error('還沒有任何提交可以推送');
  const args = ['push', '--progress'];
  if (force) args.push('--force-with-lease');
  const upRemote = st.upstream ? st.remotes.map((r) => r.name).filter((r) => st.upstream.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] : '';
  let res;
  if (st.upstream && (!rn || rn === upRemote)) {
    await git(args, top, net);
    res = { upstream: st.upstream, created: false, remote: upRemote };
  } else {
    const remote = pickRemote(st.remotes, rn);
    safeRef(st.branch, '分支名稱');
    await git([...args, '-u', remote, `HEAD:refs/heads/${st.branch}`], top, net);
    await git(['branch', `--set-upstream-to=${remote}/${st.branch}`], top, { quiet: true }).catch(() => {});
    res = { upstream: `${remote}/${st.branch}`, created: true, remote };
  }
  if (tags) {
    await git(['push', '--progress', res.remote || pickRemote(st.remotes, rn), '--tags'], top, net);
    res.tags = true;
  }
  return res;
}

function checkUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('請輸入網址');
  // eslint-disable-next-line no-control-regex
  if (u.startsWith('-') || /[\s\0-\x1f]/.test(u)) throw new Error('網址不正確');
  // ext:: 會執行任意指令
  if (/^ext::/i.test(u)) throw new Error('不支援 ext:: 網址');
  return u;
}

async function addRemote(git, top, { name, url }) {
  const n = safeRef(name || 'origin', '遠端名稱');
  if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error('遠端名稱只能有英數、. _ -');
  await git(['remote', 'add', n, checkUrl(url)], top);
}

async function setRemoteUrl(git, top, { name, url }) {
  safeRef(name, '遠端名稱');
  await git(['remote', 'set-url', name, checkUrl(url)], top);
}

async function removeRemote(git, top, { name }) {
  safeRef(name, '遠端名稱');
  await git(['remote', 'remove', name], top);
}

/** 由網址推測資料夾名稱：https://github.com/a/b.git → b */
function repoNameFromUrl(url) {
  const s = String(url || '').trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const name = s.split(/[\\/:]/).pop() || '';
  return name.replace(/[<>:"|?*]/g, '').trim();
}

/** sshCommand：指定金鑰時的 core.sshCommand，複製時使用並寫入新儲存庫的設定 */
async function clone(git, { url, parent, name, branch, sshCommand }, net) {
  const u = checkUrl(url);
  const b = String(branch || '').trim();
  if (b) safeRef(b, '分支名稱');
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('請選擇要放在哪個資料夾');
  if (!fs.existsSync(parent)) throw new Error(`資料夾不存在：${parent}`);
  const n = String(name || repoNameFromUrl(u)).trim();
  if (!n || n === '.' || n === '..' || /[\\/]/.test(n) || n.startsWith('-')) throw new Error('資料夾名稱不正確');
  const dest = path.join(parent, n);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} 已經存在而且不是空的`);
  // 取消或失敗時 git 會自己清掉它建立的資料夾
  const ssh = String(sshCommand || '').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f]/.test(ssh)) throw new Error('SSH 指令不正確');
  await git(['clone', '--progress', ...(ssh ? ['-c', `core.sshCommand=${ssh}`] : []), ...(b ? ['--branch', b] : []), '--', u, n], parent, net);
  return dest;
}

async function init(git, dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir)) throw new Error('資料夾不存在');
  await git(['init'], dir);
  return path.resolve(dir);
}

/* ───────────── 儲藏 ───────────── */

async function stashes(git, top) {
  try {
    return G.parseStashes(await git.text(['stash', 'list', '-z', '--format=%gd%x1f%at%x1f%gs'], top, { quiet: true }));
  } catch {
    return [];
  }
}

const STASH = /^stash@\{\d+\}$/;
function safeStash(ref) {
  if (typeof ref !== 'string' || !STASH.test(ref)) throw new Error('儲藏名稱不正確');
  return ref;
}

/** 儲藏；paths 有值時只儲藏這些檔案 */
async function stashPush(git, top, { message, untracked = true, paths } = {}) {
  const args = ['stash', 'push'];
  if (untracked) args.push('--include-untracked');
  const m = String(message || '').trim();
  if (m) args.push('-m', m);
  if (paths && paths.length) args.push('--', ...safePaths(top, paths));
  const r = await git(args, top);
  if (/No local changes to save/i.test(r.stdout.toString('utf8') + r.stderr)) throw new Error('沒有可以儲藏的變更');
}

async function stashApply(git, top, { ref, pop = false }) {
  safeStash(ref);
  return withConflict(git, top, () => git(['stash', pop ? 'pop' : 'apply', ref], top));
}

async function stashDrop(git, top, { ref }) {
  safeStash(ref);
  await git(['stash', 'drop', ref], top);
}

async function stashFiles(git, top, { ref }) {
  safeStash(ref);
  const files = G.parseNameStatus(await git.text(['stash', 'show', '--name-status', '-z', '-M', '--include-untracked', ref], top, { quiet: true })
    .catch(() => git.text(['stash', 'show', '--name-status', '-z', '-M', ref], top, { quiet: true })));
  const hash = (await git.text(['rev-parse', ref], top, { quiet: true })).trim();
  const parent = (await git.text(['rev-parse', `${ref}^1`], top, { quiet: true })).trim();
  let untrackedHash = '';
  try { untrackedHash = (await git.text(['rev-parse', '-q', '--verify', `${ref}^3`], top, { quiet: true })).trim(); } catch { /* 沒有未追蹤的檔案 */ }
  return { files, hash, parent, untrackedHash };
}

/* ───────────── 衝突 ───────────── */

/** 衝突檔案的資訊：工作目錄內容（含標記）、我方／對方是否存在 */
async function conflictInfo(git, top, { path: p }) {
  const rel = safeRel(top, p);
  const stages = new Set();
  const text = await git.text(['ls-files', '-u', '-z', '--', rel], top, { quiet: true });
  for (const rec of text.split('\0')) {
    const m = rec.match(/^\d+ [0-9a-f]+ ([123])\t/);
    if (m) stages.add(Number(m[1]));
  }
  const st = await status(git, top);
  const entry = st.conflict.find((c) => c.path === rel);
  const working = G.readWorking(top, rel);
  return {
    path: rel,
    xy: entry ? entry.xy : '',
    label: entry ? entry.label : '',
    resolved: !entry,
    base: stages.has(1),
    ours: stages.has(2),
    theirs: stages.has(3),
    state: st.state,
    working,
  };
}

/** 寫入解決後的內容並標示為已解決（git add） */
async function resolveText(git, top, { path: p, text, bom = false }) {
  const rel = safeRel(top, p);
  if (typeof text !== 'string') throw new Error('內容不正確');
  const f = path.join(top, rel);
  const body = Buffer.from(text, 'utf8');
  fs.writeFileSync(f, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
  await git(['add', '--', rel], top);
}

/** 整個檔案採用我方或對方的版本 */
async function takeSide(git, top, { path: p, side }) {
  const rel = safeRel(top, p);
  if (side !== 'ours' && side !== 'theirs') throw new Error('請選擇採用哪一方');
  await git(['checkout', `--${side}`, '--', rel], top);
  await git(['add', '--', rel], top);
}

async function markResolved(git, top, { path: p, remove = false }) {
  const rel = safeRel(top, p);
  if (remove) await git(['rm', '-q', '--', rel], top);
  else await git(['add', '--', rel], top);
}

module.exports = {
  topLevel, describe, gitDir, opState, status, diffSides, log, commitInfo, commitDiff,
  stage, unstage, stageAll, unstageAll, discard, commit, partial, addIgnore, formatPatch, compareWorking, compareWorkingDiff, pushTag, deleteRemoteTag, identity, setIdentity, sshCommands, setSshCommand,
  branches, checkout, createBranch, deleteBranch, renameBranch, deleteRemoteBranch, createTag, deleteTag,
  fileHistory, blame, reflog, compareRange, submodules, submoduleUpdate, worktrees, addWorktree, removeWorktree,
  merge, cherryPick, revert, reset, abortOp, continueOp, rebaseOnto, rebaseList, interactiveRebase, reword,
  fetchAll, remoteTags, assumeUnchanged, pull, push, addRemote, removeRemote, setRemoteUrl, clone, init, repoNameFromUrl, checkUrl,
  stashes, stashPush, stashApply, stashDrop, stashFiles,
  conflictInfo, resolveText, takeSide, markResolved,
};
