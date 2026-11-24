/**
 * Git 工具畫面核心：分支線圖排版、合併衝突解析與組合、行差異比對（Myers）、時間格式。
 * 全部是純函式；畫面以 <script> 載入（window.GitCore），npm test 直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GitCore = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ───────────── 分支線圖 ───────────── */

  /**
   * 為依時間排序（子提交在父提交之前）的提交計算線圖：每個提交放在哪一欄，以及欄與欄之間的連線。
   *
   * 每一欄記住「下一個預期出現的提交」。輪到某個提交時：
   *   - 預期它的欄位匯入它的節點（上半列），第一個預期它的欄位就是它的欄位；
   *   - 其他欄位直直穿過；
   *   - 第一個父提交沿用同一欄，其餘父提交（合併）找空欄或已經在等它的欄（下半列）。
   * 座標以「列」為單位：第 r 列的頂端是 r、節點在 r + 0.5、底端是 r + 1。
   *
   * @param {{ hash: string, parents: string[] }[]} commits
   * @returns {{ nodes: { col: number, color: number }[], edges: { x1: number, y1: number, x2: number, y2: number, color: number }[], width: number }}
   */
  function layoutGraph(commits) {
    const lanes = []; // 每一欄等待的提交（null = 空欄）
    const colors = []; // 每一欄的顏色編號
    let nextColor = 0;
    const nodes = [];
    const edges = [];
    let width = 0;

    const freeLane = (avoid = -1) => {
      for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i;
      lanes.push(null);
      colors.push(0);
      return lanes.length - 1;
    };

    commits.forEach((c, row) => {
      let col = lanes.indexOf(c.hash);
      if (col < 0) {
        // 分支的最新提交：開新的一欄
        col = freeLane();
        colors[col] = nextColor++;
      }
      const color = colors[col];

      // 進入這一列的線
      for (let j = 0; j < lanes.length; j++) {
        const h = lanes[j];
        if (h === null) continue;
        if (h === c.hash) {
          edges.push({ x1: j, y1: row, x2: col, y2: row + 0.5, color: colors[j] });
          if (j !== col) lanes[j] = null;
        } else {
          edges.push({ x1: j, y1: row, x2: j, y2: row + 1, color: colors[j] });
        }
      }
      lanes[col] = null;
      width = Math.max(width, lanes.length, col + 1);

      // 離開這一列的線
      (c.parents || []).forEach((p, k) => {
        let target = lanes.indexOf(p);
        // 第一個父提交留在原欄（主線不往右移）；右邊已在等它的欄會在它那一列匯入
        if (k === 0 && target > col) target = -1;
        if (target < 0) {
          if (k === 0) {
            target = col;
            colors[col] = color;
          } else {
            target = freeLane(col);
            colors[target] = nextColor++;
          }
          lanes[target] = p;
        }
        edges.push({ x1: col, y1: row + 0.5, x2: target, y2: row + 1, color: k === 0 && target === col ? color : colors[target] });
      });

      while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); colors.pop(); }
      width = Math.max(width, lanes.length);
      nodes.push({ col, color, merge: (c.parents || []).length > 1 });
    });
    return { nodes, edges, width: Math.max(1, width) };
  }

  /* ───────────── 合併衝突 ───────────── */

  const RE_START = /^<{7}(?:[ \t](.*?))?\r?\n?$/;
  const RE_BASE = /^\|{7}(?:[ \t](.*?))?\r?\n?$/;
  const RE_SEP = /^={7}\r?\n?$/;
  const RE_END = /^>{7}(?:[ \t](.*?))?\r?\n?$/;

  /** 切成行，每行保留自己的換行字元 */
  const splitKeep = (text) => String(text || '').match(/[^\n]*\n|[^\n]+$/g) || [];

  /**
   * 解析含衝突標記的文字：
   *   [{ type: 'text', text } | { type: 'conflict', index, ours, base, theirs, oursLabel, baseLabel, theirsLabel, raw }]
   * 標記不完整（例如少了 >>>>>>>）時整段當作一般文字。
   */
  function parseConflicts(text) {
    const lines = splitKeep(text);
    const segs = [];
    let plain = '';
    let cur = null;
    let part = '';
    let n = 0;
    const flush = () => { if (plain) { segs.push({ type: 'text', text: plain }); plain = ''; } };
    for (const line of lines) {
      let m;
      if (!cur) {
        if ((m = line.match(RE_START))) {
          cur = { type: 'conflict', ours: '', base: null, theirs: '', oursLabel: (m[1] || '').trim(), baseLabel: '', theirsLabel: '', raw: line };
          part = 'ours';
        } else plain += line;
        continue;
      }
      cur.raw += line;
      if (part === 'ours' && (m = line.match(RE_BASE))) { part = 'base'; cur.base = ''; cur.baseLabel = (m[1] || '').trim(); continue; }
      if ((part === 'ours' || part === 'base') && RE_SEP.test(line)) { part = 'theirs'; continue; }
      if (part === 'theirs' && (m = line.match(RE_END))) {
        cur.theirsLabel = (m[1] || '').trim();
        flush();
        cur.index = n++;
        segs.push(cur);
        cur = null;
        continue;
      }
      if (part === 'ours' && RE_START.test(line)) {
        // 巢狀或不完整的標記：之前的內容當作一般文字
        plain += cur.raw.slice(0, -line.length);
        cur = { type: 'conflict', ours: '', base: null, theirs: '', oursLabel: (line.match(RE_START)[1] || '').trim(), baseLabel: '', theirsLabel: '', raw: line };
        continue;
      }
      cur[part] += line;
    }
    if (cur) plain += cur.raw;
    flush();
    return segs;
  }

  const hasMarkers = (text) => parseConflicts(text).some((s) => s.type === 'conflict');

  /** 確保接在後面的內容另起一行 */
  const withEol = (s, eol) => (s && !s.endsWith('\n') ? s + eol : s);

  /**
   * 依每個衝突的選擇組合結果。choice：
   *   'ours' | 'theirs' | 'both'（我方在前）| 'both-theirs'（對方在前）| 'base' | { text } | undefined（保留原本的標記）
   */
  function resolveConflicts(segs, choices = {}) {
    const eol = segs.some((s) => (s.text || s.raw || '').includes('\r\n')) ? '\r\n' : '\n';
    let out = '';
    for (const s of segs) {
      if (s.type === 'text') { out += s.text; continue; }
      out += resolved(s, choices[s.index], eol);
    }
    return out;
  }

  function resolved(s, c, eol = '\n') {
    if (c === 'ours') return s.ours;
    if (c === 'theirs') return s.theirs;
    if (c === 'base') return s.base || '';
    if (c === 'both') return withEol(s.ours, eol) + s.theirs;
    if (c === 'both-theirs') return withEol(s.theirs, eol) + s.ours;
    // 手動編輯的結果少了結尾換行時補上，避免和下一行黏在一起
    if (c && typeof c === 'object' && typeof c.text === 'string') return withEol(c.text, eol);
    return s.raw;
  }

  /** 衝突標籤說明：合併時 <<<<<<< 是目前分支；重定基底時 <<<<<<< 是基底（上游），>>>>>>> 才是自己的提交 */
  function sideNames(state, oursLabel, theirsLabel) {
    if (state === 'rebase') return { ours: `上游（${oursLabel || 'HEAD'}）`, theirs: `你的提交（${theirsLabel || '傳入'}）` };
    if (state === 'stash') return { ours: `目前（${oursLabel || 'HEAD'}）`, theirs: `儲藏（${theirsLabel || 'stash'}）` };
    return { ours: `目前（${oursLabel || 'HEAD'}）`, theirs: `傳入（${theirsLabel || '對方'}）` };
  }

  /* ───────────── 時間 ───────────── */

  const pad = (n) => String(n).padStart(2, '0');
  function formatDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function ago(ms, now = Date.now()) {
    const s = Math.round((now - ms) / 1000);
    if (s < 60) return '剛剛';
    if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
    const d = new Date(ms);
    const n = new Date(now);
    return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  /* ───────────── 行差異比對 ───────────── */

  function toLines(text) {
    if (!text) return [];
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /**
   * Myers O(ND) 差異：回傳 [{ t: '=', a, b } | { t: '-', a } | { t: '+', b }]（a / b 為行索引）。
   * 先去掉相同的開頭與結尾；差異超過 maxD 時，中間整段視為刪除後新增（避免大檔案耗盡記憶體）。
   */
  function diffLines(a, b, maxD = 2000) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const ops = [];
    for (let i = 0; i < s; i++) ops.push({ t: '=', a: i, b: i });
    for (const op of myers(a.slice(s, ea), b.slice(s, eb), maxD)) {
      if (op.t === '=') ops.push({ t: '=', a: op.a + s, b: op.b + s });
      else if (op.t === '-') ops.push({ t: '-', a: op.a + s });
      else ops.push({ t: '+', b: op.b + s });
    }
    for (let i = 0; i < a.length - ea; i++) ops.push({ t: '=', a: ea + i, b: eb + i });
    return ops;
  }

  function myers(A, B, maxD) {
    const N = A.length, M = B.length;
    const replaceAll = () => [...A.map((_, a) => ({ t: '-', a })), ...B.map((_, b) => ({ t: '+', b }))];
    if (!N || !M) return replaceAll();
    // 行轉成整數比較較快
    const ids = new Map();
    const id = (l) => { let v = ids.get(l); if (v === undefined) { v = ids.size; ids.set(l, v); } return v; };
    const a = Int32Array.from(A, id), b = Int32Array.from(B, id);
    const max = N + M;
    const V = new Int32Array(2 * max + 3);
    const off = max + 1;
    const trace = [];
    let D = -1;
    for (let d = 0; d <= Math.min(max, maxD); d++) {
      trace.push(V.slice(off - d - 1, off + d + 2)); // 這一步之前的狀態，k ∈ [-d-1, d+1]
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[x] === b[y]) { x++; y++; }
        V[off + k] = x;
        if (x >= N && y >= M) { D = d; break; }
      }
      if (D >= 0) break;
    }
    if (D < 0) return replaceAll();
    const ops = [];
    let x = N, y = M;
    for (let d = D; d > 0; d--) {
      const P = trace[d];
      const get = (k) => P[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
      const prevX = get(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; ops.push({ t: '=', a: x, b: y }); }
      if (x === prevX) { y--; ops.push({ t: '+', b: y }); } else { x--; ops.push({ t: '-', a: x }); }
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { x--; y--; ops.push({ t: '=', a: x, b: y }); }
    return ops.reverse();
  }

  /** 把連續的刪除與新增整理成一組（先刪後增） */
  function blocks(ops) {
    const out = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].t === '=') { out.push({ eq: ops[i] }); i++; continue; }
      const del = [], add = [];
      while (i < ops.length && ops[i].t !== '=') { (ops[i].t === '-' ? del : add).push(ops[i]); i++; }
      out.push({ del, add });
    }
    return out;
  }

  /** 並排比對的列：{ kind: 'eq'|'mod'|'del'|'add', a, b }（a / b 為行索引或 null） */
  function sideBySide(ops) {
    const rows = [];
    for (const blk of blocks(ops)) {
      if (blk.eq) { rows.push({ kind: 'eq', a: blk.eq.a, b: blk.eq.b }); continue; }
      const n = Math.max(blk.del.length, blk.add.length);
      for (let i = 0; i < n; i++) {
        const d = blk.del[i], p = blk.add[i];
        rows.push({ kind: d && p ? 'mod' : d ? 'del' : 'add', a: d ? d.a : null, b: p ? p.b : null });
      }
    }
    return rows;
  }

  /** 行內比對的列：{ kind: 'eq'|'del'|'add', a, b } */
  function unified(ops) {
    const rows = [];
    for (const blk of blocks(ops)) {
      if (blk.eq) { rows.push({ kind: 'eq', a: blk.eq.a, b: blk.eq.b }); continue; }
      for (const d of blk.del) rows.push({ kind: 'del', a: d.a, b: null });
      for (const p of blk.add) rows.push({ kind: 'add', a: null, b: p.b });
    }
    return rows;
  }

  /**
   * 摺疊沒有變更的長段落，前後各留 context 行：回傳列與 { kind: 'fold', start, count }（start 為原列索引）。
   * expanded 是已展開的 fold start 集合。
   */
  function fold(rows, context = 3, expanded = new Set()) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].kind !== 'eq') { out.push(rows[i]); i++; continue; }
      let j = i;
      while (j < rows.length && rows[j].kind === 'eq') j++;
      const head = i === 0 ? 0 : context;
      const tail = j === rows.length ? 0 : context;
      const hidden = j - i - head - tail;
      if (hidden > 1 && !expanded.has(i + head)) {
        for (let k = i; k < i + head; k++) out.push(rows[k]);
        out.push({ kind: 'fold', start: i + head, count: hidden });
        for (let k = j - tail; k < j; k++) out.push(rows[k]);
      } else {
        for (let k = i; k < j; k++) out.push(rows[k]);
      }
      i = j;
    }
    return out;
  }

  function diffStats(ops) {
    let added = 0, removed = 0;
    for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
    return { added, removed };
  }

  /** 忽略空白比對用：去掉行首尾空白、連續空白視為一個 */
  const normWs = (l) => l.trim().replace(/\s+/g, ' ');

  /* ───────────── 逐行暫存 ───────────── */

  /** 與 toLines 一一對應、保留行尾字元的行（\r\n、\r、\n 都算一行） */
  function rawLines(text) {
    if (!text) return [];
    return String(text).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
  }

  /** 內容的簡短雜湊（FNV-1a 32 位元），用來確認畫面看到的內容和檔案目前的內容相同 */
  function textHash(s) {
    let h = 0x811c9dc5;
    const str = String(s == null ? '' : s);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${str.length.toString(36)}-${h.toString(36)}`;
  }

  /** 文字中最常用的行尾；沒有換行時回傳 null */
  function dominantEol(text) {
    const s = String(text || '');
    const crlf = (s.match(/\r\n/g) || []).length;
    const lf = (s.match(/\n/g) || []).length - crlf;
    const cr = (s.match(/\r(?!\n)/g) || []).length;
    if (!crlf && !lf && !cr) return null;
    return crlf >= lf && crlf >= cr ? '\r\n' : lf >= cr ? '\n' : '\r';
  }

  /**
   * 從 a（舊）到 b（新）的比對中，只套用一部分變更：
   *   del：要套用的刪除（a 的行索引）　add：要套用的新增（b 的行索引）
   *   invert：改成「套用沒有選取的變更」（取消暫存、捨棄用：把選取的變更退回去）
   *   target：結果要寫回哪一側（'a' 或 'b'）。沒有變更的行取自這一側，另一側的行轉成這一側的行尾
   * 回傳結果文字（不含 BOM）。
   */
  function applyPartial(aText, bText, { del = [], add = [], invert = false, target = 'a' } = {}) {
    const aRaw = rawLines(aText), bRaw = rawLines(bText);
    const ops = diffLines(toLines(aText), toLines(bText));
    const D = new Set(del), A = new Set(add);
    const pick = (op) => (op.t === '-' ? D.has(op.a) : A.has(op.b)) !== invert;
    const own = target === 'b' ? 'b' : 'a';
    const eol = dominantEol(own === 'a' ? aText : bText) || dominantEol(own === 'a' ? bText : aText) || '\n';
    const foreign = (line) => line.replace(/(\r\n|\r|\n)$/, eol);
    const out = [];
    for (const op of ops) {
      if (op.t === '=') out.push(own === 'a' ? aRaw[op.a] : bRaw[op.b]);
      else if (op.t === '-') { if (!pick(op)) out.push(own === 'a' ? aRaw[op.a] : foreign(aRaw[op.a])); } else if (pick(op)) out.push(own === 'b' ? bRaw[op.b] : foreign(bRaw[op.b]));
    }
    // 原本在檔尾、沒有換行的行被接到中間時補上換行
    for (let i = 0; i < out.length - 1; i++) if (!/[\r\n]$/.test(out[i])) out[i] += eol;
    return out.join('');
  }

  /** 選取的變更是否涵蓋全部變更（是的話改用整個檔案的操作） */
  function coversAll(aText, bText, { del = [], add = [] } = {}) {
    const D = new Set(del), A = new Set(add);
    return diffLines(toLines(aText), toLines(bText)).every((op) => op.t === '=' || (op.t === '-' ? D.has(op.a) : A.has(op.b)));
  }

  /* ───────────── 樹狀檢視 ───────────── */

  /**
   * 依「/」把項目分成資料夾：{ name, path, dirs: [節點], items: [項目] }。
   * 只有一個子資料夾、沒有項目的資料夾併成一層（a/b/c）。key(item) 取得路徑。
   */
  function buildTree(items, key = (x) => x.path) {
    const root = { name: '', path: '', dirs: new Map(), items: [] };
    for (const it of items) {
      const parts = String(key(it)).split('/');
      parts.pop();
      let node = root;
      for (const p of parts) {
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path: node.path ? `${node.path}/${p}` : p, dirs: new Map(), items: [] });
        node = node.dirs.get(p);
      }
      node.items.push(it);
    }
    const finish = (n) => {
      let dirs = [...n.dirs.values()].map(finish).sort((x, y) => x.name.localeCompare(y.name));
      dirs = dirs.map((d) => {
        let c = d;
        while (c.dirs.length === 1 && !c.items.length) c = { ...c.dirs[0], name: `${c.name}/${c.dirs[0].name}` };
        return c;
      });
      return { name: n.name, path: n.path, dirs, items: n.items };
    };
    return finish(root);
  }

  return {
    escapeHtml, layoutGraph, parseConflicts, resolveConflicts, resolved, hasMarkers, sideNames, splitKeep,
    formatDate, ago, toLines, diffLines, sideBySide, unified, fold, diffStats,
    normWs, rawLines, textHash, dominantEol, applyPartial, coversAll, buildTree,
  };
}));
