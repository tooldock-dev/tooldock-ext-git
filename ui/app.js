'use strict';
/* Git 工具畫面：儲存庫、變更與提交、分支線圖、差異比對、衝突解決、分支、儲藏、輸出 */
const td = window.tooldock;
const C = window.GitCore;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = C.escapeHtml;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const ROW = 26;
const LANE = 14;

const st = {
  info: null,
  repos: [],
  rid: null,
  status: null,
  log: null, // { commits, more }
  logLimit: 0,
  graphAll: true,
  branches: null,
  stashes: [],
  side: 'changes',
  tabs: [],
  active: null,
  seq: 0,
  collapsed: new Set(),
  selChange: '', // 變更清單中焦點所在的檔案（area\npath）
  sel: new Set(), // 變更清單中選取的檔案
  anchor: '', // Shift 連選的起點
  chgFilter: '',
  chgView: 'list', // list | tree
  commitOpts: { noVerify: false, signoff: false, push: false },
  diffWs: false, // 比對時忽略空白
  diffWrap: true, // 比對時自動換行
  brFilter: '',
  busy: null,
  progress: null,
  diffMode: 'sbs',
  msgTouched: false,
  targets: [], // 能接收 git-tool.project 的其他工具（程式碼編輯器等）
};

const repo = () => st.repos.find((r) => r.id === st.rid) || null;
const setting = (k, d) => { const v = st.info && st.info.settings[`gitTool.${k}`]; return v === undefined || v === '' ? d : v; };
const basename = (p) => String(p || '').split(/[\\/]/).pop();
const dirname = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`gt.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`gt.${k}`, JSON.stringify(v)); } catch { /* 無法保存不影響使用 */ } },
};
/** 呼叫後端，自動帶上目前儲存庫 */
const api = (name, payload = {}) => td.invoke(name, { id: st.rid, ...payload });

/* ───────────── 提示與錯誤 ───────────── */

let noticeTimer = null;
function notice(msg, kind = '') {
  const el = $('#stNotice');
  el.textContent = msg;
  el.title = msg;
  el.className = `notice ${kind}`;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => { el.textContent = ''; }, kind === 'err' ? 12000 : 6000);
}

/* ───────────── 載入中 ───────────── */
// 啟動、切換儲存庫、重新整理時蓋住畫面並擋下鍵盤，讀取完成前不能操作，避免狀態錯亂。
// （和 st.busy 不同：st.busy 是 git 指令執行中，顯示在狀態列，不擋畫面。）
// 可以巢狀（例如啟動時順便開啟上次的儲存庫），全部離開才收起；離開時還原外層的說明文字。
const loading = {
  depth: 1, // index.html 的 #loading 預設就是開著的：初始化完成前都算載入中
  stack: [['正在啟動 Git 工具…', '']],
  enter(title, detail = '') {
    if (!this.depth) {
      const a = document.activeElement;
      if (a && a !== document.body) a.blur();
      $('#loading').classList.add('on');
    }
    this.depth++;
    this.stack.push([title, detail]);
    this.show();
  },
  /** 更新目前這一層的進度說明 */
  step(detail) {
    const top = this.stack[this.stack.length - 1];
    if (top) { top[1] = detail || ''; this.show(); }
  },
  leave() {
    if (!this.depth) return;
    this.depth--;
    this.stack.pop();
    if (this.depth) this.show(); else $('#loading').classList.remove('on');
  },
  show() {
    const [title, detail] = this.stack[this.stack.length - 1] || ['', ''];
    const b = $('#loading');
    $('.t', b).textContent = title;
    $('.d', b).textContent = detail;
  },
};
async function withLoading(title, fn) {
  loading.enter(title);
  try { return await fn(); } finally { loading.leave(); }
}
// 載入中不接受鍵盤（遮罩已經擋住滑鼠）；用 capture 搶在各輸入框與快捷鍵之前
document.addEventListener('keydown', (e) => {
  if (!loading.depth) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
/** 初始化完成（設定、儲存庫清單都讀好了）；其他工具送來的指令要等這個才執行 */
let markReady;
const ready = new Promise((r) => { markReady = r; });

/** 後端錯誤格式：「[代碼] 訊息」 */
function errInfo(err) {
  const s = String((err && err.message) || err || '');
  const m = s.match(/^(?:Error: )?\[([A-Z_]+)\] ([\s\S]*)$/);
  return m ? { code: m[1], message: m[2] } : { code: '', message: s.replace(/^Error: /, '') };
}

const AUTH_HELP = '登入方式：\n・HTTPS：在終端機對這個遠端執行一次 git fetch 或 git push，依提示登入（GitHub 可用 gh auth setup-git），之後系統的認證管理員會記住帳號。\n・SSH：在「＋」選單的「SSH 金鑰」產生金鑰，把公鑰加到遠端帳號，並把遠端改成 SSH 網址。';

function fail(err) {
  const e = errInfo(err);
  notice(e.message, 'err');
  if (e.code === 'AUTH') {
    td.dialog.message({ type: 'warning', message: e.message, detail: AUTH_HELP, buttons: ['知道了'] }).catch(() => {});
  } else if (e.code === 'SSH_KEY' || e.code === 'SSH_HOST') {
    choose(e.message, ['開啟 SSH 金鑰…', '知道了'], { type: 'warning', detail: e.code === 'SSH_KEY'
      ? '在「SSH 金鑰」可以產生金鑰、複製公鑰貼到網站，或為這個儲存庫指定要用哪一把金鑰（同一個網站有多個帳號時）。'
      : '在「SSH 金鑰」測試一次連線，就會記住這台主機的金鑰（~/.ssh/known_hosts）。' })
      .then((i) => { if (i === 0) return sshPanel(); return null; }).catch(fail);
  } else if (e.code === 'SSH_HOST_CHANGED') {
    td.dialog.message({ type: 'warning', message: e.message, detail: '確認是主機合法更換金鑰後，從 ~/.ssh/known_hosts 移除這台主機的舊紀錄（終端機：ssh-keygen -R <主機>），再重新連線。', buttons: ['知道了'] }).catch(() => {});
  } else if (e.code === 'NO_GIT') {
    td.dialog.message({ type: 'warning', message: e.message, detail: '請到 https://git-scm.com/downloads 下載安裝 Git；已安裝在其他位置時，到 ToolDock 的擴充設定填寫「git 執行檔」。', buttons: ['知道了'] }).catch(() => {});
  }
}

async function choose(message, buttons, { detail = '', type = 'question', cancel = buttons.length - 1 } = {}) {
  const r = await td.dialog.message({ type, message, detail, buttons, defaultId: 0, cancelId: cancel });
  return r && typeof r.response === 'number' ? r.response : cancel;
}
const confirmBox = async (message, ok = '確定', opts = {}) => (await choose(message, [ok, '取消'], opts)) === 0;

function banner(msg, actions = [], kind = '') {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.className = kind;
  $('.msg', b).textContent = msg;
  const acts = $('.acts', b);
  acts.innerHTML = '';
  for (const [label, fn, cls] of actions) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = `sm ${cls || 'secondary'}`;
    btn.onclick = () => Promise.resolve(fn()).catch(fail);
    acts.append(btn);
  }
  b.hidden = false;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  notice('已複製');
}

/* ───────────── 對話框（表單） ───────────── */

/**
 * 表單對話框。fields：{ name, label, type: 'text'|'checkbox'|'select'|'textarea', value, placeholder, help, options: [[值, 名稱]], browse }
 * validate(values) 回傳錯誤訊息（字串）時不關閉。回傳 values 或 null（取消）。
 */
function form({ title, desc = '', fields, ok = '確定', validate, onInput }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalDesc').textContent = desc;
    $('#modalHint').textContent = '';
    $('#modalOk').textContent = ok;
    const box = $('#modalFields');
    box.innerHTML = '';
    for (const f of fields) {
      const id = `f_${f.name}`;
      const wrap = document.createElement('div');
      if (f.type === 'checkbox') {
        wrap.className = 'fld chk';
        wrap.innerHTML = `<input type="checkbox" id="${id}" ${f.value ? 'checked' : ''}><label for="${id}">${esc(f.label)}</label>`;
      } else {
        wrap.className = 'fld';
        let input;
        if (f.type === 'select') input = `<select id="${id}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        else if (f.type === 'textarea') input = `<textarea id="${id}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}" spellcheck="false"></textarea>`;
        else input = `<input type="${f.type === 'password' ? 'password' : 'text'}" id="${id}" placeholder="${esc(f.placeholder || '')}" spellcheck="false" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}">`;
        wrap.innerHTML = `<label for="${id}">${esc(f.label)}</label><div class="in">${input}${f.browse ? '<button type="button" class="secondary sm" data-browse>選擇…</button>' : ''}</div>${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}`;
        const el = $(`#${id}`, wrap);
        if (f.type !== 'select') el.value = f.value || '';
        if (f.browse) {
          $('[data-browse]', wrap).onclick = async () => {
            const r = await td.dialog.open({ title: f.label, defaultPath: el.value || undefined, properties: ['openDirectory', 'createDirectory'] });
            if (r && !r.canceled && r.filePaths && r.filePaths[0]) { el.value = r.filePaths[0]; el.dispatchEvent(new Event('input', { bubbles: true })); }
          };
        }
      }
      box.append(wrap);
    }
    const values = () => Object.fromEntries(fields.map((f) => {
      const el = $(`#f_${f.name}`);
      return [f.name, f.type === 'checkbox' ? el.checked : el.value];
    }));
    box.oninput = (e) => { if (onInput) onInput(e.target.id.slice(2), values(), (name, v) => { $(`#f_${name}`).value = v; }); };
    m.hidden = false;
    const first = $('input[type="text"], textarea, select', box);
    if (first) { first.focus(); if (first.select) first.select(); }
    const done = (v) => {
      m.hidden = true;
      $('#modalBox').onsubmit = null;
      $('#modalCancel').onclick = null;
      m.onkeydown = null;
      box.oninput = null;
      resolve(v);
    };
    $('#modalBox').onsubmit = (e) => {
      e.preventDefault();
      const v = values();
      const msg = validate ? validate(v) : '';
      if (msg) { $('#modalHint').textContent = msg; return; }
      done(v);
    };
    $('#modalCancel').onclick = () => done(null);
    m.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#modalBox').requestSubmit(); }
    };
  });
}

const ask = async (title, value = '', opts = {}) => {
  const r = await form({ title, fields: [{ name: 'v', label: opts.label || '', value, placeholder: opts.placeholder, help: opts.help }], ok: opts.ok || '確定', validate: opts.validate && ((v) => opts.validate(v.v)) });
  return r ? r.v.trim() : null;
};

/* ───────────── 選單 ───────────── */

function closeMenus() { for (const m of $$('.menu')) m.hidden = true; }

/** 右鍵或按鈕選單：items 為 [名稱, 動作, { danger, disabled }]、'-'（分隔線）或 { label }（小標題） */
function popup(items, x, y) {
  closeMenus();
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { if (m.lastElementChild && !m.lastElementChild.classList.contains('sep')) m.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
    if (it.label) { m.insertAdjacentHTML('beforeend', `<div class="label">${esc(it.label)}</div>`); continue; }
    const b = document.createElement('button');
    b.className = `item${it[2] && it[2].danger ? ' danger' : ''}`;
    b.textContent = it[0];
    b.disabled = !!(it[2] && it[2].disabled);
    b.onclick = () => { m.hidden = true; Promise.resolve(it[1]()).catch(fail); };
    m.append(b);
  }
  if (m.lastElementChild && m.lastElementChild.classList.contains('sep')) m.lastElementChild.remove();
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
const contextMenu = (e, items) => { e.preventDefault(); e.stopPropagation(); popup(items, e.clientX, e.clientY); };
const menuBelow = (el, items) => { const r = el.getBoundingClientRect(); popup(items, r.left, r.bottom + 4); };

/* ───────────── 進度 ───────────── */

function renderProgress() {
  const p = st.progress;
  const box = $('#stProgress');
  if (!p && !st.busy) { box.hidden = true; return; }
  box.hidden = false;
  $('.t', box).textContent = p ? `${p.title}${p.text ? `：${p.text}` : '…'}` : `${st.busy.title}…`;
  $('.t', box).title = $('.t', box).textContent;
  $('#cancelBtn').hidden = !p;
}

/* ───────────── 儲存庫 ───────────── */

function renderRepoSel() {
  const sel = $('#repoSel');
  sel.innerHTML = st.repos.length
    ? st.repos.map((r) => `<option value="${esc(r.id)}" ${r.id === st.rid ? 'selected' : ''} title="${esc(r.root)}">${esc(r.name)}</option>`).join('')
    : '<option value="">（尚未加入儲存庫）</option>';
  sel.disabled = !st.repos.length;
  const r = repo();
  $('#stRepo').textContent = r ? r.root : '';
  $('#stRepo').title = r ? r.root : '';
}

/** 切換儲存庫：一次只跑一個，連續切換會排隊依序處理，不會兩個儲存庫的資料混在一起 */
let selectChain = Promise.resolve();
function selectRepo(id) {
  const run = selectChain.then(() => {
    const r = id && st.repos.find((x) => x.id === id);
    return withLoading(r ? `正在開啟儲存庫「${r.name}」…` : '正在關閉儲存庫…', () => loadRepo(id));
  });
  selectChain = run.catch(() => { /* 錯誤交給呼叫端 */ });
  return run;
}

async function loadRepo(id) {
  loading.step('關閉分頁');
  st.rid = id || null;
  st.status = null;
  st.log = null;
  st.branches = null;
  st.stashes = [];
  st.selChange = '';
  st.remoteTags = null;
  st.cmpBase = null;
  st.subs = null;
  st.worktrees = null;
  st.search = null;
  st.sel.clear();
  st.anchor = '';
  st.msgTouched = false;
  $('#msg').value = '';
  $('#amend').checked = false;
  for (const t of [...st.tabs]) if (!t.fixed) closeTab(t.id, true);
  renderRepoSel();
  await td.invoke('selectRepo', st.rid);
  updateLayout();
  if (st.rid) {
    loading.step('讀取狀態、線圖與儲藏');
    await refreshAll();
  }
}

function updateLayout() {
  const has = !!repo();
  $('#welcome').hidden = has;
  $('#tabs').hidden = !has;
  for (const t of st.tabs) t.view.el.hidden = !has || t.id !== st.active;
  $$('#toolbar button').forEach((b) => { if (b.id !== 'outBtn') b.disabled = !has; });
  if (!has) {
    $('#changes').innerHTML = '<div class="empty-msg">先加入或複製一個儲存庫。</div>';
    $('#branches').innerHTML = '';
    $('#stashes').innerHTML = '';
    $('#chgCount').hidden = true;
    $('#stashCount').hidden = true;
    $('#brName').textContent = '—';
    $('#brAb').textContent = '';
    banner('');
  }
}

async function addRepoFlow(dir) {
  if (!dir) {
    const r = await td.dialog.open({ title: '選擇 Git 儲存庫資料夾', properties: ['openDirectory'] });
    if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return;
    dir = r.filePaths[0];
  }
  try {
    const res = await td.invoke('addRepo', { root: dir });
    st.repos = res.repos;
    await selectRepo(res.repo.id);
    notice(res.existed ? '這個儲存庫已在清單中' : `已加入「${res.repo.name}」`, 'ok');
  } catch (err) {
    if (errInfo(err).code === 'NOT_REPO' && await confirmBox(`${basename(dir)} 不是 Git 儲存庫。要在這個資料夾建立新的儲存庫（git init）嗎？`, '建立儲存庫', { detail: dir })) {
      await initRepoFlow(dir);
      return;
    }
    throw err;
  }
}

async function initRepoFlow(dir) {
  if (!dir) {
    const r = await td.dialog.open({ title: '選擇要建立儲存庫的資料夾', properties: ['openDirectory', 'createDirectory'] });
    if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return;
    dir = r.filePaths[0];
  }
  const res = await td.invoke('initRepo', { root: dir });
  st.repos = res.repos;
  await selectRepo(res.repo.id);
  notice(`已建立儲存庫「${res.repo.name}」`, 'ok');
}

/** preset：從分享的專案帶入 { url, name, branch, desc } */
async function cloneFlow(preset = {}) {
  const d = await td.invoke('defaults');
  const keys = (await td.invoke('ssh:keys').catch(() => [])).filter((k) => k.private);
  let autoName = !preset.name;
  const v = await form({
    title: '複製遠端儲存庫（clone）',
    desc: preset.desc || '把遠端的儲存庫完整下載到本機，之後就能提交、推送與拉取。',
    ok: '複製',
    fields: [
      { name: 'url', label: '儲存庫網址', value: preset.url || '', placeholder: 'https://github.com/使用者/專案.git 或 git@github.com:使用者/專案.git', help: '私人儲存庫需要先在系統中登入（HTTPS 的認證管理員或 SSH 金鑰）' },
      { name: 'parent', label: '放在哪個資料夾', value: store.get('cloneParent', d.cloneDir), browse: true },
      { name: 'name', label: '資料夾名稱', value: preset.name || '', placeholder: '依網址自動命名' },
      { name: 'branch', label: '分支（選填）', value: preset.branch || '', placeholder: '留空時使用遠端的預設分支' },
      ...(keys.length > 1 ? [{ name: 'sshKey', label: 'SSH 金鑰（SSH 網址才會用到）', type: 'select', value: '', options: [['', '自動（ssh 預設的金鑰）'], ...keys.map((k) => [k.name, `${k.name}${k.comment ? `（${k.comment}）` : ''}`])], help: '同一個網站有多個帳號時，選擇這個儲存庫要用的金鑰；之後的推送、拉取也會使用它' }] : []),
    ],
    onInput: async (field, v, set) => {
      if (field === 'name') autoName = !v.name;
      if (field === 'url' && autoName) set('name', await td.invoke('repoName', v.url));
    },
    validate: (v) => (!v.url.trim() ? '請輸入儲存庫網址' : !v.parent.trim() ? '請選擇放置的資料夾' : ''),
  });
  if (!v) return;
  store.set('cloneParent', v.parent.trim());
  const res = await td.invoke('clone', { url: v.url.trim(), parent: v.parent.trim(), name: v.name.trim() || undefined, branch: v.branch.trim() || undefined, sshKey: v.sshKey || undefined });
  st.repos = res.repos;
  await selectRepo(res.repo.id);
  notice(`已複製到 ${res.repo.root}`, 'ok');
}

/* ───────────── SSH 金鑰：產生、取得公鑰、切換、測試連線 ───────────── */

const ssh = { s: null, target: '', testKey: null, result: null, testing: false };
const sshOpen = () => !$('#sshPanel').hidden;

async function sshPanel() {
  closeMenus();
  ssh.s = await td.invoke('ssh:state', { id: st.rid });
  ssh.result = null;
  const r = ssh.s.remotes.find((x) => x.ssh);
  ssh.target = r ? `${r.ssh.user}@${r.ssh.host}${r.ssh.port ? `:${r.ssh.port}` : ''}` : (ssh.target || 'git@github.com');
  ssh.testKey = null; // null：依目前的設定
  $('#sshPanel').hidden = false;
  renderSsh();
}

function closeSsh() { $('#sshPanel').hidden = true; }

async function reloadSsh() {
  ssh.s = await td.invoke('ssh:state', { id: st.rid });
  renderSsh();
}

/** 目前生效的金鑰名稱：儲存庫設定 > 全域設定 > ''（ssh 預設） */
const effectiveKey = () => (ssh.s.local.value ? ssh.s.local.key || '' : ssh.s.global.value ? ssh.s.global.key || '' : '');
const keyLabel = (k) => `${k.name}${k.comment ? `（${k.comment}）` : ''}`;
const targetHost = () => (/^(?:[^@]+@)?([^:]+)/.exec(ssh.target.trim()) || [])[1] || '';

function keySelect(scope, conf) {
  const keys = ssh.s.keys.filter((k) => k.private);
  const cur = conf.value ? (conf.custom && !conf.key ? '__custom' : conf.key || '__custom') : '';
  const opts = [['', scope === 'local' ? '跟隨全域設定／ssh 預設' : '自動（ssh 預設的金鑰與 ~/.ssh/config）'], ...keys.map((k) => [k.name, keyLabel(k)])];
  if (cur === '__custom' || (cur && !keys.some((k) => k.name === cur))) opts.push(['__custom', `自訂：${conf.value}`]);
  return `<select data-ssh-scope="${scope}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''} ${v === '__custom' ? 'disabled' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

function renderSsh() {
  const s = ssh.s;
  const eff = effectiveKey();
  const rows = s.keys.map((k) => {
    const tags = [
      `<span class="tag">${esc(k.label)}${k.bits ? ` ${k.bits}` : ''}</span>`,
      s.repo && s.local.key === k.name ? '<span class="tag on">這個儲存庫使用</span>' : '',
      s.global.key === k.name ? '<span class="tag on">全域預設</span>' : '',
      !k.default && !k.configured ? '<span class="tag" title="不是 ssh 預設的檔名，也沒有寫在 ~/.ssh/config；需要在下方「使用哪一把金鑰」指定才會被使用">需要指定才會使用</span>' : '',
      k.weak ? '<span class="tag warn" title="DSA 或小於 2048 位元的 RSA，多數網站已不接受">已過時</span>' : '',
      !k.private ? '<span class="tag warn" title="只有公鑰，找不到對應的私鑰檔">沒有私鑰</span>' : '',
    ].join('');
    return `<div class="krow" data-key="${esc(k.name)}"><div class="kmain"><span class="kname">${esc(k.name)}</span>${tags}`
      + `<div class="kmeta" title="${esc(k.file)}">${esc(k.comment || '（沒有註解）')} · ${esc(k.fingerprint)}</div></div>`
      + `<div class="kacts"><button class="sm" data-ssh="copy">複製公鑰</button><button class="ib sm" data-ssh="keyMenu" title="更多">⋯</button></div></div>`;
  }).join('');
  const host = targetHost();
  const pages = Object.entries(s.pages);
  const httpsRemotes = s.remotes.filter((r) => r.sshUrl);
  const testOpts = [['__eff', `目前的設定（${eff || 'ssh 預設'}）`], ['', 'ssh 預設的金鑰'], ...s.keys.filter((k) => k.private).map((k) => [k.name, keyLabel(k)])];
  const tk = ssh.testKey === null ? '__eff' : ssh.testKey;
  const res = ssh.testing ? '<div class="sshResult">連線中…</div>'
    : ssh.result ? `<div class="sshResult ${ssh.result.ok ? 'ok' : 'err'}">${ssh.result.ok ? '✓ ' : '✗ '}${esc(ssh.result.message)}${ssh.result.hostAdded ? '\n已記住這台主機的金鑰（~/.ssh/known_hosts）。' : ''}</div>` : '';
  $('#sshBody').innerHTML = `
    <p class="desc">遠端使用 SSH 網址（例如 git@github.com:使用者/專案.git）時，git 用這台電腦的金鑰登入。把<b>公鑰</b>加到網站的帳號後就能推送與拉取；私鑰只留在這台電腦，不要給任何人。</p>
    <h4>這台電腦的金鑰<span class="dim">${esc(s.dir)}</span></h4>
    ${s.keys.length ? `<div class="keys">${rows}</div>` : '<div class="empty-msg">還沒有 SSH 金鑰。按「產生新金鑰」建立一把。</div>'}
    <div class="row2" style="margin-top:8px"><button class="sm" data-ssh="generate">＋ 產生新金鑰…</button><button class="secondary sm" data-ssh="reveal">開啟 ~/.ssh 資料夾</button><button class="secondary sm" data-ssh="reload">↻</button></div>

    <h4>加到網站</h4>
    <div class="row2">複製公鑰後，貼到網站的「新增 SSH 金鑰」頁面：${pages.map(([h, p]) => `<button class="secondary sm" data-ssh="page" data-host="${esc(h)}">${esc(p.title)} ↗</button>`).join('')}</div>

    <h4>使用哪一把金鑰</h4>
    ${s.repo ? `<div class="row2"><label>這個儲存庫（${esc(s.repo.name)}）</label>${keySelect('local', s.local)}</div>` : ''}
    <div class="row2"><label>所有儲存庫（全域預設）</label>${keySelect('global', s.global)}</div>
    <div class="hint">同一個網站有多個帳號（例如公司與個人的 GitHub）時，為每個儲存庫指定金鑰。指定後只會用那一把，不會再嘗試其他金鑰。設定寫在 git 的 core.sshCommand。</div>

    <h4>測試連線</h4>
    <div class="row2"><input id="sshTarget" value="${esc(ssh.target)}" placeholder="git@github.com" spellcheck="false"><select id="sshTestKey">${testOpts.map(([v, l]) => `<option value="${esc(v)}" ${v === tk ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><button class="sm" data-ssh="test" ${ssh.testing ? 'disabled' : ''}>測試</button></div>
    ${res}
    <div class="hint">第一次連線到一台主機時會記住它的金鑰（~/.ssh/known_hosts）；之後主機金鑰改變時會拒絕連線。</div>
    ${httpsRemotes.length ? `<h4>這個儲存庫的遠端</h4>${httpsRemotes.map((r) => `<div class="row2"><span>${esc(r.name)} 使用 HTTPS（${esc(r.url)}），不會用到 SSH 金鑰。</span><button class="secondary sm" data-ssh="toSsh" data-remote="${esc(r.name)}">改用 SSH 網址</button></div>`).join('')}` : ''}
  `;
  if (host && s.pages[host]) $(`[data-ssh="page"][data-host="${host}"]`).classList.remove('secondary');
}

async function sshCopy(name) {
  const k = await td.invoke('ssh:publicKey', name);
  await copyText(k.text);
  notice(`已複製 ${name}.pub 的公鑰，貼到網站的「新增 SSH 金鑰」頁面`, 'ok');
  return k;
}

async function sshUse(scope, key) {
  const conf = scope === 'local' ? ssh.s.local : ssh.s.global;
  if (conf.custom && conf.value && !await confirmBox(`${scope === 'local' ? '這個儲存庫' : '全域'}已經有自訂的 SSH 指令，要取代它嗎？`, '取代', { detail: conf.value })) { renderSsh(); return; }
  ssh.s = await td.invoke('ssh:use', { id: st.rid, scope, key });
  ssh.testKey = null;
  renderSsh();
  notice(key ? `${scope === 'local' ? '這個儲存庫' : '所有儲存庫'}改用 ${key}` : (scope === 'local' ? '這個儲存庫改為跟隨全域設定' : '全域改回 ssh 預設的金鑰'), 'ok');
}

async function sshGenerate() {
  const s = ssh.s;
  let touched = false;
  const v = await form({
    title: '產生新的 SSH 金鑰',
    desc: '金鑰存在 ~/.ssh，不會覆蓋現有的檔案。產生後公鑰會自動複製，貼到網站的「新增 SSH 金鑰」頁面即可。',
    ok: '產生',
    fields: [
      { name: 'type', label: '類型', type: 'select', value: 'ed25519', options: [['ed25519', 'Ed25519（建議）'], ['rsa', 'RSA 4096（給不支援 Ed25519 的舊伺服器）']] },
      { name: 'name', label: '檔名', value: s.suggest.ed25519, help: s.keys.length ? '不是 id_ed25519、id_rsa 這類預設檔名時，要在「使用哪一把金鑰」指定給儲存庫才會被使用' : '' },
      { name: 'comment', label: '註解（通常填 email，方便在網站上辨識）', value: s.email || '' },
      { name: 'pass', label: '密碼（選填）', type: 'password', placeholder: '留空不設密碼', help: '設了密碼的金鑰，要先在終端機用 ssh-add 加入 ssh-agent，這裡的推送、拉取才能使用' },
    ],
    onInput: (field, val, set) => {
      if (field === 'name') touched = true;
      if (field === 'type' && !touched) set('name', s.suggest[val.type]);
    },
    validate: (val) => (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(val.name.trim()) || /\.pub$/i.test(val.name.trim()) ? '檔名只能有英數與 . _ -，而且不能以 .pub 結尾'
      : val.pass && val.pass.length < 5 ? '密碼至少要 5 個字元（或留空）' : ''),
  });
  if (!v) return;
  const r = await td.invoke('ssh:generate', { name: v.name.trim(), type: v.type, comment: v.comment.trim(), passphrase: v.pass });
  await copyText(r.text);
  await reloadSsh();
  const k = ssh.s.keys.find((x) => x.name === r.name);
  const host = targetHost();
  const page = ssh.s.pages[host] || ssh.s.pages['github.com'];
  const notes = [`指紋：${r.fingerprint}`, '公鑰已複製到剪貼簿，貼到網站的「新增 SSH 金鑰」頁面後，按「測試連線」確認。'];
  if (k && !k.default && !k.configured) notes.push(`${r.name} 不是 ssh 預設的檔名，請在「使用哪一把金鑰」把它指定給儲存庫。`);
  if (r.hasPassphrase) notes.push(`這把金鑰有密碼，請先在終端機加入 ssh-agent：\nssh-add ${IS_MAC ? '--apple-use-keychain ' : ''}~/.ssh/${r.name}`);
  const i = await choose(`已產生金鑰 ${r.name}`, [`開啟 ${page.title} 新增頁`, '關閉'], { type: 'info', detail: notes.join('\n\n'), cancel: 1 });
  if (i === 0) await td.shell.openExternal(page.url);
}

async function sshTest() {
  ssh.target = $('#sshTarget').value.trim();
  const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?$/.exec(ssh.target);
  if (!m) { notice('請輸入「使用者@主機」，例如 git@github.com', 'err'); return; }
  const sel = $('#sshTestKey').value;
  ssh.testKey = sel === '__eff' ? null : sel;
  const key = sel === '__eff' ? effectiveKey() : sel;
  ssh.testing = true;
  ssh.result = null;
  renderSsh();
  try {
    ssh.result = await td.invoke('ssh:test', { user: m[1] || 'git', host: m[2], port: m[3] ? Number(m[3]) : null, key });
  } catch (err) {
    ssh.result = { ok: false, message: errInfo(err).message };
  } finally {
    ssh.testing = false;
    if (sshOpen()) renderSsh();
  }
}

async function sshToSsh(name) {
  const r = ssh.s.remotes.find((x) => x.name === name);
  if (!r || !r.sshUrl) return;
  if (!await confirmBox(`把遠端 ${name} 改成 SSH 網址？`, '變更', { detail: `${r.url}\n→ ${r.sshUrl}\n\n之後推送、拉取會用 SSH 金鑰登入。要改回來時，在分支面板的遠端清單移除後重新新增即可。` })) return;
  await api('setRemoteUrl', { name, url: r.sshUrl });
  await reloadSsh();
  ssh.target = `git@${(/^git@([^:]+):/.exec(r.sshUrl) || [])[1] || 'github.com'}`;
  renderSsh();
  notice(`${name} 已改用 ${r.sshUrl}`, 'ok');
}

function initSsh() {
  const box = $('#sshBody');
  $('#sshPanel').addEventListener('mousedown', (e) => { if (e.target.id === 'sshPanel') closeSsh(); });
  $('[data-ssh="close"]').onclick = closeSsh;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ssh]');
    if (!b) return;
    const act = b.dataset.ssh;
    const key = b.closest('.krow') && b.closest('.krow').dataset.key;
    const run = {
      copy: () => sshCopy(key),
      keyMenu: () => {
        const k = ssh.s.keys.find((x) => x.name === key);
        menuBelow(b, [
          ['複製公鑰', () => sshCopy(key)],
          '-',
          ...(ssh.s.repo ? [['設為這個儲存庫使用', () => sshUse('local', key), { disabled: !k.private }]] : []),
          ['設為所有儲存庫的預設', () => sshUse('global', key), { disabled: !k.private }],
          ['用這把金鑰測試連線', () => { ssh.testKey = key; renderSsh(); return sshTest(); }, { disabled: !k.private }],
          '-',
          ['在檔案管理員中顯示', () => td.shell.showItemInFolder(k.file)],
        ]);
      },
      generate: sshGenerate,
      reveal: () => td.invoke('ssh:reveal'),
      reload: reloadSsh,
      page: () => td.shell.openExternal(ssh.s.pages[b.dataset.host].url),
      test: sshTest,
      toSsh: () => sshToSsh(b.dataset.remote),
    }[act];
    if (run) Promise.resolve(run()).catch(fail);
  });
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-ssh-scope]');
    if (sel) sshUse(sel.dataset.sshScope, sel.value).catch((err) => { renderSsh(); fail(err); });
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'sshTarget') { e.preventDefault(); sshTest().catch(fail); } });
}

/* ───────────── 專案交換：在其他工具開啟、分享給別人 ───────────── */

/** 重新查詢能接收專案的工具，更新選單文字 */
async function refreshTargets() {
  try {
    st.targets = td.exchange ? await td.exchange.receivers('git-tool.project') : [];
  } catch { st.targets = []; }
  const item = $('#openInItem');
  item.hidden = !st.targets.length;
  item.textContent = targetLabel();
}
const targetLabel = () => (st.targets.length === 1 ? st.targets[0].title || `在${st.targets[0].name}開啟` : '在其他工具開啟…');

async function openInFlow(opts = {}) {
  const r = await api('openIn', opts);
  if (r.status === 'cancelled') return;
  if (r.status === 'exported') return;
  notice(r.message || (r.receiver ? `已交給${r.receiver.name}` : '已開啟'), 'ok');
}

async function shareFileFlow() {
  let r;
  try {
    r = await api('shareFile');
  } catch (err) {
    if (errInfo(err).code === 'NO_REMOTE') {
      if (await confirmBox('這個儲存庫還沒有設定網路上的遠端', '新增遠端…', { detail: '分享的交換檔只包含遠端網址與分支，對方要從遠端（例如 GitHub）複製。請先新增遠端並推送。' })) await addRemoteFlow();
      return;
    }
    throw err;
  }
  if (!r) return;
  const i = await choose(`已存成 ${basename(r.filePath)}`, ['在檔案管理員中顯示', '關閉'], {
    type: 'info',
    detail: `把這個檔案傳給對方，對方在 ToolDock 開啟（或拖到視窗上）後，就能用 Git 工具複製這個專案。\n\n遠端：${r.remote}${r.branch ? `\n分支：${r.branch}` : ''}\n\n檔案不含你的帳號密碼與本機路徑。私人儲存庫需要對方有存取權限。`,
  });
  if (i === 0) await td.shell.showItemInFolder(r.filePath);
}

/** 收到分享的專案（只有遠端）：清單中已有相同遠端時詢問，否則開啟帶好網址的複製對話框 */
async function cloneProjectFlow({ project, existing = [], origin }) {
  if (existing.length) {
    const e = existing[0];
    const i = await choose(`清單中已經有「${e.name}」，和收到的專案是同一個遠端`, ['開啟現有的儲存庫', '另外複製一份', '取消'], { detail: e.root });
    if (i === 0) { st.repos = await td.invoke('repos'); await selectRepo(e.id); return; }
    if (i !== 1) return;
  }
  const remote = project.remotes[0];
  await cloneFlow({
    url: remote.url,
    name: '',
    branch: project.branch || '',
    desc: `${origin === 'file' ? '從交換檔' : '從其他工具'}收到專案「${project.name}」。請確認網址是你信任的來源，按「複製」後才會開始下載。`,
  });
}

async function importCommand(c) {
  if (c.command === 'openRepo') {
    st.repos = await td.invoke('repos');
    if (st.rid !== c.id) await selectRepo(c.id); else renderRepoSel();
    return;
  }
  if (c.command === 'addRepo') return addRepoFlow(c.dir);
  if (c.command === 'cloneProject') return cloneProjectFlow(c);
}

async function removeRepoFlow() {
  const r = repo();
  if (!r) return;
  if (!await confirmBox(`從清單移除「${r.name}」？`, '移除', { detail: '只會從這裡的清單移除，不會刪除資料夾與檔案。' })) return;
  st.repos = await td.invoke('removeRepo', r.id);
  await selectRepo(st.repos[0] ? st.repos[0].id : null);
}

async function renameRepoFlow() {
  const r = repo();
  if (!r) return;
  const n = await ask('重新命名（只改變清單中的名稱）', r.name, { validate: (x) => (!x.trim() ? '名稱不能是空的' : '') });
  if (!n) return;
  st.repos = await td.invoke('renameRepo', { id: r.id, name: n });
  renderRepoSel();
}

async function identityFlow(reason = '') {
  const cur = await api('identity');
  const v = await form({
    title: '提交者名稱與 email',
    desc: reason || '每個提交都會記錄提交者的名稱與 email。',
    ok: '儲存',
    fields: [
      { name: 'name', label: '名稱', value: cur.name, placeholder: '例如：王小明' },
      { name: 'email', label: 'Email', value: cur.email, placeholder: 'you@example.com', help: '推送到 GitHub 時，用帳號的 email 才會連結到你的帳號' },
      { name: 'global', label: '套用到這台電腦的所有儲存庫（git config --global）', type: 'checkbox', value: true },
    ],
    validate: (x) => (!x.name.trim() || !x.email.trim() ? '名稱與 email 都要填寫' : !/^[^\s@]+@[^\s@]+$/.test(x.email.trim()) ? 'email 格式不正確' : ''),
  });
  if (!v) return false;
  await api('setIdentity', { name: v.name.trim(), email: v.email.trim(), global: v.global });
  notice('已儲存提交者資訊', 'ok');
  return true;
}

/* ───────────── 重新整理 ───────────── */

let refreshing = null;
let refreshAgain = false;
/** 重新讀取狀態；graph = true 時也重新讀取線圖、分支與儲藏 */
async function refresh({ graph = false } = {}) {
  if (!st.rid) return;
  if (graph) refreshAgain = 'graph';
  if (refreshing) { refreshAgain = refreshAgain || true; return refreshing; }
  refreshing = (async () => {
    try {
      do {
        const g = refreshAgain === 'graph' || graph;
        refreshAgain = false;
        graph = false;
        const rid = st.rid;
        const s = await api('status');
        if (rid !== st.rid) return;
        st.status = s;
        renderStatus();
        if (g) {
          const [stashes] = await Promise.all([api('stashes'), loadLog(), st.side === 'branches' ? loadBranches() : null]);
          if (rid !== st.rid) return;
          st.stashes = stashes;
          if (st.side !== 'branches') st.branches = null;
          renderStashes();
        }
        for (const t of st.tabs) if (t.view.onStatus) t.view.onStatus();
      } while (refreshAgain);
    } catch (err) {
      fail(err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
const refreshAll = () => refresh({ graph: true });

function renderStatus() {
  const s = st.status;
  if (!s) return;
  // 工具列
  const name = s.detached ? `（分離的 HEAD）${s.head ? s.head.short : ''}` : s.branch || '—';
  $('#brName').textContent = name;
  $('#branchBtn').title = s.upstream ? `目前分支 ${name}，追蹤 ${s.upstream}` : `目前分支 ${name}（沒有追蹤的遠端分支）`;
  $('#brAb').textContent = s.upstreamGone ? '遠端已刪除' : '';
  $('#pullCnt').textContent = s.behind ? String(s.behind) : '';
  $('#pushCnt').textContent = s.ahead ? String(s.ahead) : '';
  $('[data-act="push"]').title = s.upstream ? `推送到 ${s.upstream}（push）` : '推送並在遠端建立同名分支（push -u）';
  renderChanges();
  renderBanner();
  renderCommitBox();
}

const STATE_NAME = { merge: '合併', rebase: '重定基底', 'cherry-pick': '揀選提交', revert: '還原提交' };

function renderBanner() {
  const s = st.status;
  if (!s) return banner('');
  if (s.state) {
    const n = s.conflict.length;
    const nm = STATE_NAME[s.state] || s.state;
    if (n) {
      banner(`${nm}進行中：還有 ${n} 個衝突檔案。點左側「合併衝突」中的檔案逐段解決。`, [
        ['解決下一個', () => openConflict(s.conflict[0].path), ''],
        [`中止${nm}`, abortFlow],
      ]);
    } else {
      banner(`${nm}進行中：衝突都已解決。`, [
        [s.state === 'merge' ? '完成合併' : '繼續', () => continueFlow(), ''],
        [`中止${nm}`, abortFlow],
      ], 'ok');
    }
    return;
  }
  if (s.detached) {
    banner('目前在分離的 HEAD（不在任何分支上）。在這裡做的提交不屬於任何分支，建議先建立分支。', [
      ['從這裡建立分支…', () => newBranchFlow()],
    ], 'info');
    return;
  }
  banner('');
}

function renderCommitBox() {
  const s = st.status;
  const btn = $('#commitBtn');
  const msg = $('#msg');
  if (s && s.state) {
    btn.textContent = s.state === 'merge' ? '✓ 完成合併' : '✓ 繼續';
    btn.title = s.state === 'merge' ? '提交合併結果' : `繼續${STATE_NAME[s.state] || ''}`;
    if (!st.msgTouched && s.mergeMessage && !msg.value) msg.value = s.mergeMessage;
    $('#amend').closest('label').hidden = true;
  } else {
    const n = s ? s.staged.length : 0;
    btn.textContent = n ? `✓ 提交 ${n} 個檔案` : '✓ 提交';
    btn.title = `提交已暫存的變更（${IS_MAC ? '⌘' : 'Ctrl+'}Enter）${st.commitOpts.push ? '，完成後推送' : ''}`;
    $('#amend').closest('label').hidden = !s || s.noCommits;
  }
  msg.placeholder = s && s.branch ? `提交訊息（在 ${s.branch} 上提交，${IS_MAC ? '⌘' : 'Ctrl+'}Enter）\n第一行是摘要，空一行後寫詳細說明` : '提交訊息';
  renderMsgLen();
}

/** 摘要（第一行）的字數：超過 72 時提示 */
function renderMsgLen() {
  const first = $('#msg').value.split('\n')[0];
  const n = [...first].length;
  const el = $('#msgLen');
  el.textContent = n ? String(n) : '';
  el.className = n > 72 ? 'warn' : '';
  el.title = n > 72 ? `摘要有 ${n} 個字，建議不超過 72（太長時在其他工具中會被截斷）` : '摘要（第一行）的字數，建議不超過 72';
  const o = st.commitOpts;
  $('#commitOpts').classList.toggle('on', o.noVerify || o.signoff || o.push);
}

function commitOptsMenu() {
  const o = st.commitOpts;
  const flip = (k) => () => { o[k] = !o[k]; store.set('commitOpts', o); renderCommitBox(); };
  menuBelow($('#commitOpts'), [
    { label: '提交選項' },
    [`${o.push ? '✓' : '　'} 提交後推送`, flip('push')],
    [`${o.signoff ? '✓' : '　'} 加上 Signed-off-by（--signoff）`, flip('signoff')],
    [`${o.noVerify ? '✓' : '　'} 略過 Git hooks（--no-verify）`, flip('noVerify')],
  ]);
}

function msgHistMenu() {
  const list = store.get('msgHist', []);
  if (!list.length) { notice('還沒有提交過的訊息'); return; }
  menuBelow($('#msgHist'), [{ label: '最近使用的提交訊息' }, ...list.map((m) => [m.split('\n')[0].slice(0, 80), () => {
    $('#msg').value = m;
    st.msgTouched = true;
    renderMsgLen();
    $('#msg').focus();
  }])]);
}

function rememberMsg(m) {
  const t = String(m || '').trim();
  if (!t) return;
  store.set('msgHist', [t, ...store.get('msgHist', []).filter((x) => x !== t)].slice(0, 20));
}

/* ───────────── 變更清單 ───────────── */

const GROUPS = [['conflict', '合併衝突'], ['staged', '已暫存的變更'], ['unstaged', '變更'], ['untracked', '未追蹤的檔案'], ['assumed', '假設未變更的檔案']];
const keyOf = (area, p) => `${area}\n${p}`;
const splitKey = (k) => { const i = k.indexOf('\n'); return [k.slice(0, i), k.slice(i + 1)]; };
const isMod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** 符合篩選的檔案 */
function shown(area) {
  const q = st.chgFilter.trim().toLowerCase();
  const list = st.status[area];
  return q ? list.filter((e) => e.path.toLowerCase().includes(q)) : list;
}

function groupActs(area, attr) {
  if (area === 'staged') return `<button class="ib sm" ${attr}="unstage" title="全部取消暫存">−</button>`;
  if (area === 'unstaged') return `<button class="ib sm" ${attr}="discard" title="捨棄全部變更">↺</button><button class="ib sm" ${attr}="stage" title="全部暫存">＋</button>`;
  if (area === 'untracked') return `<button class="ib sm" ${attr}="discard" title="刪除全部未追蹤的檔案">🗑</button><button class="ib sm" ${attr}="stage" title="全部暫存">＋</button>`;
  if (area === 'assumed') return `<button class="ib sm" ${attr}="unassume" title="全部取消「假設未變更」">↶</button>`;
  return '';
}

function fileRow(area, e, depth, tree) {
  const key = keyOf(area, e.path);
  let ra = '';
  if (area === 'conflict') ra = '<button class="ib sm" data-ract="resolve" title="解決衝突">⚡</button>';
  else if (area === 'staged') ra = '<button class="ib sm" data-ract="openFile" title="開啟檔案">↗</button><button class="ib sm" data-ract="unstage" title="取消暫存">−</button>';
  else if (area === 'assumed') ra = '<button class="ib sm" data-ract="unassume" title="取消「假設未變更」，重新顯示這個檔案的變更">↶</button>';
  else if (area === 'unstaged') ra = `${e.status !== 'D' ? '<button class="ib sm" data-ract="openFile" title="開啟檔案">↗</button>' : ''}<button class="ib sm" data-ract="discard" title="捨棄變更">↺</button><button class="ib sm" data-ract="stage" title="暫存">＋</button>`;
  else ra = '<button class="ib sm" data-ract="openFile" title="開啟檔案">↗</button><button class="ib sm" data-ract="discard" title="刪除檔案">🗑</button><button class="ib sm" data-ract="stage" title="暫存">＋</button>';
  const tip = `${e.path}${e.orig ? `（原為 ${e.orig}）` : ''}・${e.label}`;
  const pad = tree ? ` style="padding-left:${12 + depth * 14}px"` : '';
  return `<div class="row f${st.sel.has(key) ? ' sel' : ''}${st.selChange === key ? ' focus' : ''}" data-area="${area}" data-path="${esc(e.path)}" title="${esc(tip)}"${pad}>`
    + `<span class="nm g-${esc(e.status)}${e.status === 'D' ? ' del' : ''}">${esc(basename(e.path))}</span><span class="dir">${tree ? '' : esc(dirname(e.path))}</span>`
    + `<span class="acts">${ra}</span><span class="gs g-${esc(e.status)}">${area === 'conflict' ? '!' : esc(e.status === '?' ? 'U' : e.status)}</span></div>`;
}

function treeRows(area, node, depth, out) {
  const count = (n) => n.items.length + n.dirs.reduce((s, d) => s + count(d), 0);
  for (const d of node.dirs) {
    const k = `d:${area}:${d.path}`;
    const closed = st.collapsed.has(k);
    out.push(`<div class="row dirrow" data-area="${area}" data-dir="${esc(d.path)}" style="padding-left:${2 + depth * 14}px" title="${esc(d.path)}/">`
      + `<span class="tw">${closed ? '▸' : '▾'}</span><span class="ic">📁</span><span class="nm">${esc(d.name)}</span><span class="dir"></span>`
      + `<span class="acts">${groupActs(area, 'data-dact')}</span><span class="meta">${count(d)}</span></div>`);
    if (!closed) treeRows(area, d, depth + 1, out);
  }
  for (const e of node.items) out.push(fileRow(area, e, depth, true));
}

function renderChanges() {
  const s = st.status;
  const box = $('#changes');
  const total = s.conflict.length + s.staged.length + s.unstaged.length + s.untracked.length;
  s.assumed = s.assumed || [];
  $('#chgCount').hidden = !total;
  $('#chgCount').textContent = total > 999 ? '999+' : String(total);
  $('#chgView').textContent = st.chgView === 'tree' ? '🗂' : '☰';
  $('#chgView').title = st.chgView === 'tree' ? '目前：樹狀檢視（點選切換成清單）' : '目前：清單檢視（點選切換成樹狀）';
  // 已經不存在的檔案從選取中移除
  for (const k of [...st.sel]) { const [a, p] = splitKey(k); if (!entryOf(a, p)) st.sel.delete(k); }
  if (!total && !s.assumed.length) {
    box.innerHTML = `<div class="empty-msg">沒有任何變更，工作目錄是乾淨的。${s.noCommits ? '<br>這個儲存庫還沒有任何提交：新增檔案後會出現在這裡。' : ''}</div>`;
    return;
  }
  const out = [];
  const tree = st.chgView === 'tree';
  for (const [area, title] of GROUPS) {
    const list = shown(area);
    if (!s[area].length) continue;
    const closed = st.collapsed.has(area);
    const n = list.length === s[area].length ? `${list.length}` : `${list.length}／${s[area].length}`;
    out.push(`<div class="grp-h ${area}" data-grp="${area}"><span class="tw">${closed ? '▸' : '▾'}</span>${title}<span class="n">${n}</span><span class="acts">${groupActs(area, 'data-gact')}</span></div>`);
    if (closed) continue;
    if (tree) treeRows(area, C.buildTree(list), 0, out);
    else for (const e of list) out.push(fileRow(area, e, 0, false));
  }
  if (st.chgFilter.trim() && !out.some((x) => x.includes('class="row f'))) out.push('<div class="empty-msg">沒有符合篩選的檔案。</div>');
  box.innerHTML = out.join('');
}

function entryOf(area, p) {
  return st.status && st.status[area] ? st.status[area].find((e) => e.path === p) : null;
}

/** 畫面上依序排列的檔案（用於 Shift 連選與方向鍵） */
const rowKeys = () => $$('#changes .row.f').map((r) => keyOf(r.dataset.area, r.dataset.path));

function markSel() {
  for (const r of $$('#changes .row.f')) {
    const k = keyOf(r.dataset.area, r.dataset.path);
    r.classList.toggle('sel', st.sel.has(k));
    r.classList.toggle('focus', st.selChange === k);
  }
}

function selectRange(from, to) {
  const keys = rowKeys();
  let i = keys.indexOf(from), j = keys.indexOf(to);
  if (i < 0) i = j;
  if (i > j) [i, j] = [j, i];
  st.sel = new Set(keys.slice(i, j + 1));
}

/** 選取的檔案；沒有選取時用目前焦點的檔案 */
function selectedItems() {
  const keys = st.sel.size ? [...st.sel] : st.selChange ? [st.selChange] : [];
  return keys.map(splitKey).map(([area, p]) => ({ area, path: p, e: entryOf(area, p) })).filter((x) => x.e);
}

function openEntry(area, p, opts) {
  if (area === 'assumed') { notice('這個檔案標示為「假設未變更」，git 不會檢查它的變更；取消後才會顯示差異'); return; }
  if (area === 'conflict') openConflict(p);
  else openDiff({ kind: 'work', area, ...entryOf(area, p) }, opts);
}

async function onChangeAction(act, area, p) {
  const e = entryOf(area, p);
  if (!e) return;
  if (act === 'resolve') { openConflict(p); return; }
  if (act === 'openFile') { await api('openFile', { path: p }); return; }
  await batchAction(act, [{ area, path: p, e }]);
}

/**
 * 對多個檔案執行：stage、unstage、toggle（依選取內容暫存或取消暫存）、discard、stash
 * items：[{ area, path }]
 */
async function batchAction(act, items) {
  const s = st.status;
  const uniq = (a) => [...new Set(a)];
  const toStage = uniq(items.filter((x) => x.area === 'unstaged' || x.area === 'untracked').map((x) => x.path));
  const toUnstage = uniq(items.filter((x) => x.area === 'staged').map((x) => x.path));
  if (act === 'toggle') act = toStage.length ? 'stage' : 'unstage';
  if (act === 'stage') {
    if (!toStage.length) return;
    await api('stage', { paths: toStage });
  } else if (act === 'unstage') {
    if (!toUnstage.length) return;
    await api('unstage', { paths: toUnstage, noCommits: s.noCommits });
  } else if (act === 'discard') {
    const tracked = uniq(items.filter((x) => x.area === 'unstaged').map((x) => x.path));
    const untracked = uniq(items.filter((x) => x.area === 'untracked').map((x) => x.path));
    if (!tracked.length && !untracked.length) { notice('選取的檔案沒有可以捨棄的變更（已暫存的請先取消暫存）'); return; }
    const one = tracked.length + untracked.length === 1;
    const msg = one
      ? (tracked.length ? `捨棄 ${tracked[0]} 的變更？` : `刪除未追蹤的檔案 ${untracked[0]}？`)
      : [tracked.length ? `捨棄 ${tracked.length} 個檔案的變更` : '', untracked.length ? `刪除 ${untracked.length} 個未追蹤的檔案` : ''].filter(Boolean).join('、') + '？';
    const detail = [tracked.length ? '已追蹤的檔案會還原成上一次暫存或提交的內容。' : '', untracked.length ? '未追蹤的檔案從來沒有提交過，刪除後無法從 Git 復原。' : '', '這個動作無法復原。'].filter(Boolean).join('\n');
    if (!await confirmBox(msg, untracked.length && !tracked.length ? '刪除' : '捨棄', { type: 'warning', detail })) return;
    await api('discard', { tracked, untracked });
  } else if (act === 'unassume') {
    const paths = uniq(items.filter((x) => x.area === 'assumed').map((x) => x.path));
    if (!paths.length) return;
    await api('assume', { paths, on: false });
    notice(`已取消 ${paths.length} 個檔案的「假設未變更」`, 'ok');
  } else if (act === 'assume') {
    const paths = uniq(items.filter((x) => x.area === 'unstaged' || x.area === 'staged').map((x) => x.path));
    if (!paths.length) return;
    if (!await confirmBox(`把 ${paths.length === 1 ? paths[0] : `${paths.length} 個檔案`} 標示為「假設未變更」？`, '標示', { detail: 'git 會當作這些檔案沒有變更：不會出現在變更清單、也不會被暫存或提交。適合本機才需要修改的設定檔。之後可以在變更清單最下面的「假設未變更的檔案」取消。\n已暫存的變更仍然會被提交。' })) return;
    await api('assume', { paths, on: true });
  } else if (act === 'stash') {
    const paths = uniq(items.filter((x) => x.area !== 'conflict' && x.area !== 'assumed').map((x) => x.path));
    if (!paths.length) return;
    const v = await form({
      title: `儲藏 ${paths.length === 1 ? paths[0] : `${paths.length} 個檔案`}`,
      desc: '只把選取的檔案收起來，其他變更保留在工作目錄。',
      ok: '儲藏',
      fields: [{ name: 'message', label: '說明（可省略）' }],
    });
    if (!v) return;
    await api('stash', { message: v.message, untracked: true, paths });
    notice('已儲藏選取的檔案', 'ok');
    st.sel.clear();
    await refreshAll();
    return;
  }
  await refresh();
}

async function onGroupAction(act, area, dir) {
  const s = st.status;
  const list = dir ? shown(area).filter((e) => e.path.startsWith(`${dir}/`)) : shown(area);
  if (!list.length) return;
  // 沒有篩選、整組操作時用 git 的整批指令
  if (!dir && !st.chgFilter.trim() && area === 'staged' && act === 'unstage') { await api('unstageAll', { noCommits: s.noCommits }); await refresh(); return; }
  await batchAction(act, list.map((e) => ({ area, path: e.path, e })));
}

async function ignoreFlow(pattern) {
  const r = await api('ignore', { pattern });
  notice(r.added ? `已加入 .gitignore：${pattern}` : `.gitignore 已經有 ${pattern}`, 'ok');
  await refresh();
}

function ignoreItems(p, isDir) {
  const ext = !isDir && /\.([^./]+)$/.exec(basename(p));
  const dir = isDir ? p : dirname(p);
  return [
    { label: '加入 .gitignore' },
    isDir ? null : ['　忽略這個檔案', () => ignoreFlow(`/${p}`)],
    ext ? [`　忽略所有 *.${ext[1]} 檔案`, () => ignoreFlow(`*.${ext[1]}`)] : null,
    dir ? [`　忽略資料夾 ${dir}/`, () => ignoreFlow(`/${dir}/`)] : null,
  ];
}

function fileMenu(area, p) {
  const e = entryOf(area, p);
  const items = [];
  if (area === 'assumed') {
    return [
      ['取消「假設未變更」', () => batchAction('unassume', [{ area, path: p, e }])],
      '-',
      ['開啟檔案', () => api('openFile', { path: p })],
      ['在檔案管理員中顯示', () => api('revealFile', { path: p })],
      ['複製相對路徑', () => copyText(p)],
      ['檔案歷史', () => openHistory(p)],
    ];
  }
  if (area === 'conflict') items.push(['解決衝突', () => openConflict(p)]);
  else items.push(['查看差異', () => openDiff({ kind: 'work', area, ...e }, { pin: true })]);
  if (area === 'unstaged' || area === 'untracked') items.push(['暫存', () => onChangeAction('stage', area, p)]);
  if (area === 'staged') items.push(['取消暫存', () => onChangeAction('unstage', area, p)]);
  items.push('-');
  if (e && e.status !== 'D') items.push(['開啟檔案', () => api('openFile', { path: p })]);
  if (e && e.status !== 'D') items.push(['在檔案管理員中顯示', () => api('revealFile', { path: p })], ['在終端機開啟所在的資料夾', () => api('openTerminal', { path: p })]);
  if (e && e.status !== 'D' && st.targets.length) items.push([targetLabel(), () => openInFlow({ file: p })]);
  items.push(['複製相對路徑', () => copyText(p)]);
  if (area !== 'untracked' && !(e && e.status === 'A')) items.push('-', ['檔案歷史', () => openHistory(p)], e && e.status !== 'D' ? ['逐行追溯（blame）', () => openBlame(p)] : null);
  if (area !== 'conflict') items.push('-', ['儲藏這個檔案…', () => batchAction('stash', [{ area, path: p, e }])]);
  if (area === 'untracked') items.push('-', ...ignoreItems(p, false));
  if ((area === 'unstaged' || area === 'staged') && e && e.status !== 'A' && e.status !== 'D') items.push(['假設未變更（不再顯示這個檔案的變更）…', () => batchAction('assume', [{ area, path: p, e }])]);
  if (area === 'unstaged') items.push('-', ['捨棄變更…', () => onChangeAction('discard', area, p), { danger: true }]);
  if (area === 'untracked') items.push('-', ['刪除檔案…', () => onChangeAction('discard', area, p), { danger: true }]);
  return items;
}

function multiMenu(items) {
  const n = items.length;
  const stg = items.filter((x) => x.area === 'unstaged' || x.area === 'untracked').length;
  const uns = items.filter((x) => x.area === 'staged').length;
  const dis = items.filter((x) => x.area === 'unstaged' || x.area === 'untracked').length;
  return [
    { label: `已選取 ${n} 個檔案` },
    stg ? [`暫存 ${stg} 個檔案`, () => batchAction('stage', items)] : null,
    uns ? [`取消暫存 ${uns} 個檔案`, () => batchAction('unstage', items)] : null,
    items.some((x) => x.area === 'assumed') ? ['取消「假設未變更」', () => batchAction('unassume', items)] : null,
    '-',
    [`儲藏這 ${n} 個檔案…`, () => batchAction('stash', items)],
    ['複製相對路徑', () => copyText(items.map((x) => x.path).join('\n'))],
    '-',
    dis ? [`捨棄 ${dis} 個檔案的變更…`, () => batchAction('discard', items), { danger: true }] : null,
  ];
}

function initChanges() {
  const box = $('#changes');
  st.chgView = store.get('chgView', 'list');
  $('#chgFilter').addEventListener('input', (e) => { st.chgFilter = e.target.value; if (st.status) renderChanges(); });
  $('#chgFilter').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); box.focus(); moveFocus(1, false); } });
  $('#chgView').onclick = () => { st.chgView = st.chgView === 'tree' ? 'list' : 'tree'; store.set('chgView', st.chgView); if (st.status) renderChanges(); };

  box.addEventListener('click', (ev) => {
    const g = ev.target.closest('[data-gact]');
    if (g) { ev.stopPropagation(); onGroupAction(g.dataset.gact, g.closest('.grp-h').dataset.grp).catch(fail); return; }
    const h = ev.target.closest('.grp-h');
    if (h) {
      const a = h.dataset.grp;
      if (st.collapsed.has(a)) st.collapsed.delete(a); else st.collapsed.add(a);
      renderChanges();
      return;
    }
    const dr = ev.target.closest('.dirrow');
    if (dr) {
      const da = ev.target.closest('[data-dact]');
      if (da) { onGroupAction(da.dataset.dact, dr.dataset.area, dr.dataset.dir).catch(fail); return; }
      const k = `d:${dr.dataset.area}:${dr.dataset.dir}`;
      if (st.collapsed.has(k)) st.collapsed.delete(k); else st.collapsed.add(k);
      renderChanges();
      return;
    }
    const row = ev.target.closest('.row.f');
    if (!row) return;
    const { area, path: p } = row.dataset;
    const b = ev.target.closest('[data-ract]');
    if (b) { ev.stopPropagation(); onChangeAction(b.dataset.ract, area, p).catch(fail); return; }
    const key = keyOf(area, p);
    if (ev.shiftKey && st.anchor) selectRange(st.anchor, key);
    else if (isMod(ev)) { if (st.sel.has(key)) st.sel.delete(key); else st.sel.add(key); st.anchor = key; } else { st.sel = new Set([key]); st.anchor = key; }
    st.selChange = key;
    markSel();
    if (!ev.shiftKey && !isMod(ev)) openEntry(area, p);
  });
  box.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('.row.f');
    if (!row || ev.target.closest('[data-ract]') || ev.shiftKey || isMod(ev)) return;
    const { area, path: p } = row.dataset;
    if (area === 'unstaged' || area === 'untracked') onChangeAction('stage', area, p).catch(fail);
    else if (area === 'staged') onChangeAction('unstage', area, p).catch(fail);
  });
  box.addEventListener('contextmenu', (ev) => {
    const dr = ev.target.closest('.dirrow');
    if (dr) {
      const { area, dir } = dr.dataset;
      const n = shown(area).filter((e) => e.path.startsWith(`${dir}/`)).length;
      contextMenu(ev, [
        { label: `${dir}/（${n} 個檔案）` },
        area === 'unstaged' || area === 'untracked' ? ['暫存這個資料夾', () => onGroupAction('stage', area, dir)] : null,
        area === 'staged' ? ['取消暫存這個資料夾', () => onGroupAction('unstage', area, dir)] : null,
        ['複製路徑', () => copyText(dir)],
        area === 'untracked' ? '-' : null,
        ...(area === 'untracked' ? ignoreItems(dir, true) : []),
        area === 'unstaged' || area === 'untracked' ? '-' : null,
        area === 'unstaged' || area === 'untracked' ? [area === 'untracked' ? '刪除資料夾中的檔案…' : '捨棄這個資料夾的變更…', () => onGroupAction('discard', area, dir), { danger: true }] : null,
      ]);
      return;
    }
    const row = ev.target.closest('.row.f');
    if (!row) return;
    const { area, path: p } = row.dataset;
    const key = keyOf(area, p);
    if (!st.sel.has(key)) { st.sel = new Set([key]); st.anchor = key; st.selChange = key; markSel(); }
    const items = selectedItems();
    contextMenu(ev, items.length > 1 ? multiMenu(items) : fileMenu(area, p));
  });
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); moveFocus(ev.key === 'ArrowDown' ? 1 : -1, ev.shiftKey); return; }
    if (isMod(ev) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); st.sel = new Set(rowKeys()); markSel(); return; }
    if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); const it = selectedItems(); if (it.length) batchAction('toggle', it).catch(fail); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); const it = selectedItems(); if (it.length) batchAction('discard', it).catch(fail); return; }
    if (ev.key === 'Escape') { st.sel.clear(); markSel(); }
  });
}

/** 方向鍵移動焦點；extend 時延伸選取範圍 */
function moveFocus(dir, extend) {
  const keys = rowKeys();
  if (!keys.length) return;
  let i = keys.indexOf(st.selChange);
  i = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + dir));
  const key = keys[i];
  st.selChange = key;
  if (extend && st.anchor) selectRange(st.anchor, key); else { st.sel = new Set([key]); st.anchor = key; }
  markSel();
  const row = $$('#changes .row.f')[i];
  if (row) row.scrollIntoView({ block: 'nearest' });
  if (!extend) { const [a, p] = splitKey(key); openEntry(a, p); }
}

/* ───────────── 提交 ───────────── */

async function commitFlow() {
  const s = st.status;
  if (!s) return;
  const msg = $('#msg').value;
  if (s.state) { await continueFlow(); return; }
  const amend = $('#amend').checked;
  if (!amend && !s.staged.length) {
    const others = s.unstaged.length + s.untracked.length;
    if (!others) { notice('沒有可以提交的變更'); return; }
    if (!await confirmBox(`沒有已暫存的變更。要暫存全部 ${others} 個變更後提交嗎？`, '全部暫存並提交')) return;
    if (!msg.trim()) { notice('請輸入提交訊息', 'err'); $('#msg').focus(); return; }
    await api('stageAll');
  }
  if (!amend && !msg.trim()) { notice('請輸入提交訊息', 'err'); $('#msg').focus(); return; }
  let pushAfter = false;
  try {
    const o = st.commitOpts;
    const head = await api('commit', { message: msg, amend, noVerify: o.noVerify, signoff: o.signoff });
    rememberMsg(msg);
    $('#msg').value = '';
    $('#amend').checked = false;
    st.msgTouched = false;
    notice(`已提交：${head}`, 'ok');
    pushAfter = o.push;
  } catch (err) {
    if (errInfo(err).code === 'NO_IDENTITY') {
      if (await identityFlow('還沒有設定提交者的名稱與 email，設定後才能提交。')) { await commitFlow(); return; }
      return;
    }
    throw err;
  } finally {
    await refreshAll();
  }
  if (pushAfter) await pushFlow();
}

async function onAmendToggle() {
  const s = st.status;
  if (!$('#amend').checked || !s || !s.head) return;
  if (!$('#msg').value.trim()) {
    const info = await api('commit:info', { hash: s.head.hash });
    $('#msg').value = info.message;
  }
}

async function continueFlow() {
  const s = st.status;
  try {
    const r = await api('continue', { message: s.state === 'merge' ? $('#msg').value : '' });
    if (r.conflict) { await onConflict(r); return; }
    $('#msg').value = '';
    st.msgTouched = false;
    notice(`${STATE_NAME[r.state] || ''}已完成`, 'ok');
  } catch (err) {
    if (errInfo(err).code === 'NO_IDENTITY') {
      if (await identityFlow('還沒有設定提交者的名稱與 email，設定後才能完成合併。')) await continueFlow();
      return;
    }
    throw err;
  } finally {
    await refreshAll();
  }
}

async function abortFlow() {
  const s = st.status;
  const nm = STATE_NAME[s.state] || '';
  if (!await confirmBox(`中止${nm}？`, `中止${nm}`, { type: 'warning', detail: `會回到${nm}之前的狀態，已經解決的衝突也會一併捨棄。` })) return;
  await api('abort');
  for (const t of [...st.tabs]) if (t.kind === 'conflict') closeTab(t.id, true);
  $('#msg').value = '';
  st.msgTouched = false;
  notice(`已中止${nm}`, 'ok');
  await refreshAll();
}

/** 合併、拉取等產生衝突時：切到變更、開啟第一個衝突檔案 */
async function onConflict(r) {
  await refreshAll();
  setSide('changes');
  notice(`有 ${r.files ? r.files.length : st.status.conflict.length} 個檔案發生衝突，請逐一解決`, 'err');
  const first = (r.files && r.files[0]) || (st.status.conflict[0] && st.status.conflict[0].path);
  if (first) openConflict(first);
}

/* ───────────── 會覆蓋變更的操作 ───────────── */

/** 執行 fn；因為有未提交的變更而失敗時，詢問是否先儲藏、完成後再取回 */
async function withStash(title, fn) {
  try {
    return await fn();
  } catch (err) {
    const e = errInfo(err);
    if (e.code !== 'DIRTY') throw err;
    const c = await choose(`${e.message}`, ['儲藏變更後繼續', '取消'], { type: 'warning', detail: `先把變更儲藏起來，${title}完成後再自動取回。` });
    if (c !== 0) return null;
    await api('stash', { message: `自動儲藏（${title}前）`, untracked: true });
    let r;
    try {
      r = await fn();
    } catch (err2) {
      notice(`${title}失敗，變更已儲藏在「儲藏」分頁`, 'err');
      throw err2;
    }
    if (r && r.conflict) {
      notice(`變更已儲藏在「儲藏」分頁，解決衝突後再取回`);
      return r;
    }
    const pop = await api('stash:apply', { ref: 'stash@{0}', pop: true });
    if (pop.conflict) {
      await onConflict(pop);
      notice('取回儲藏的變更時發生衝突，解決後請到「儲藏」分頁刪除這筆儲藏', 'err');
      return null;
    }
    return r;
  }
}

/* ───────────── 遠端 ───────────── */

async function fetchFlow(opts = {}) {
  try {
    await api('fetch', opts);
    notice(opts.pruneTags ? '已擷取，並刪除遠端已經不存在的標籤' : '已擷取最新的遠端提交', 'ok');
  } catch (err) {
    if (errInfo(err).code === 'NO_REMOTE') { if (await addRemoteFlow('這個儲存庫還沒有設定遠端。')) await fetchFlow(); return; }
    throw err;
  } finally {
    await refreshAll();
  }
}

/** 拉取對話框（工具列的拉取）：選遠端分支與拉取方式 */
async function pullDialog() {
  const s = st.status;
  if (!s) return;
  if (!(s.remotes || []).length || s.detached) { await pullFlow(); return; }
  const b = await ensureBranches();
  const def = s.upstream || (b.remote.find((x) => x.name === `${defaultRemote()}/${s.branch}`) || {}).name || '';
  if (!b.remote.length) { await pullFlow(); return; }
  const v = await form({
    title: '拉取',
    desc: `把遠端分支的提交拉進目前分支 ${s.branch}${s.behind ? `（落後 ${s.behind} 個提交）` : ''}。`,
    ok: '拉取',
    fields: [
      { name: 'ref', label: '遠端分支', type: 'select', value: def, options: [...(def ? [] : [['', '（選擇遠端分支）']]), ...b.remote.map((x) => [x.name, `${x.name}${x.name === s.upstream ? '（追蹤中）' : ''}`])] },
      { name: 'mode', label: '拉取方式', type: 'select', value: store.get('pullMode', setting('pullMode', 'merge')), options: [['merge', '合併（merge）'], ['rebase', '重定基底（rebase，自動儲藏未提交的變更）'], ['ff-only', '只允許快轉（ff-only）']] },
    ],
    validate: (x) => (!x.ref ? '請選擇遠端分支' : ''),
  });
  if (!v) return;
  store.set('pullMode', v.mode);
  const rn = remoteOf(v.ref);
  await pullFlow(v.ref === s.upstream ? { mode: v.mode } : { mode: v.mode, remote: rn, branch: v.ref.slice(rn.length + 1) });
}

async function pullFlow(opts = {}) {
  try {
    const r = await withStash('拉取', () => api('pull', opts));
    if (!r) return;
    if (r.conflict) { await onConflict(r); return; }
    notice(/Already up.to.date/i.test(r.output || '') ? '已經是最新的' : '已拉取遠端的提交', 'ok');
  } catch (err) {
    const e = errInfo(err);
    if (e.code === 'NO_REMOTE') { if (await addRemoteFlow('這個儲存庫還沒有設定遠端。')) await pullFlow(opts); return; }
    if (e.code === 'NO_UPSTREAM') {
      if (await confirmBox(e.message, '推送', { detail: '推送後會在遠端建立同名分支並設定追蹤，之後就能拉取。' })) await pushFlow();
      return;
    }
    if (e.code === 'NOT_FF') {
      notice(`${e.message}（設定「gitTool.pullMode」）`, 'err');
      return;
    }
    throw err;
  } finally {
    await refreshAll();
  }
}

/** 遠端分支名稱（origin/main）所屬的遠端 */
function remoteOf(ref) {
  const names = ((st.status && st.status.remotes) || []).map((r) => r.name);
  return names.filter((r) => String(ref || '').startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] || '';
}
const defaultRemote = () => {
  const rs = (st.status && st.status.remotes) || [];
  return remoteOf(st.status && st.status.upstream) || ((rs.find((r) => r.name === 'origin') || rs[0]) || {}).name || '';
};

/** 推送對話框（工具列的推送）：選遠端、推送所有標籤、強制推送 */
async function pushDialog() {
  const s = st.status;
  if (!s) return;
  const remotes = s.remotes || [];
  if (!remotes.length || s.detached || s.noCommits) { await pushFlow(); return; }
  const def = defaultRemote();
  const fields = [];
  if (remotes.length > 1) fields.push({ name: 'remote', label: '推送到遠端', type: 'select', value: def, options: remotes.map((r) => [r.name, `${r.name}（${r.url}）`]) });
  fields.push(
    { name: 'tags', label: '同時推送所有標籤（git push --tags）', type: 'checkbox', value: store.get('pushTags', false) },
    { name: 'force', label: '強制推送（--force-with-lease，覆蓋遠端的分支）', type: 'checkbox', value: false },
  );
  const target = s.upstream || `${def}/${s.branch}`;
  const v = await form({
    title: '推送',
    desc: `把 ${s.branch} 推送到 ${target}${s.ahead ? `（${s.ahead} 個提交）` : s.upstream ? '（沒有新的提交）' : '（會在遠端建立這個分支並設定追蹤）'}`,
    ok: '推送',
    fields,
  });
  if (!v) return;
  store.set('pushTags', v.tags);
  if (v.force && !await confirmBox('確定要強制推送嗎？', '強制推送', { type: 'warning', detail: '遠端分支上本機沒有的提交會被移除，其他人的工作可能因此遺失。' })) return;
  await pushFlow({ remote: v.remote || def, tags: v.tags, force: v.force });
}

async function pushFlow(opts = {}) {
  try {
    const r = await api('push', opts);
    const tags = r.tags ? '，也推送了所有標籤' : '';
    notice(r.created ? `已推送並建立遠端分支 ${r.upstream}${tags}` : `已推送到 ${r.upstream}${tags}`, 'ok');
  } catch (err) {
    const e = errInfo(err);
    if (e.code === 'NO_REMOTE') { if (await addRemoteFlow('這個儲存庫還沒有設定遠端，請輸入要推送到的遠端網址。')) await pushFlow(opts); return; }
    if (e.code === 'REJECTED' && !opts.force) {
      const c = await choose('遠端有你還沒有的提交，推送被拒絕。', ['先拉取再推送', '強制推送（覆蓋遠端）', '取消'], {
        type: 'warning',
        detail: '建議先拉取：把遠端的提交合併進來後再推送。\n強制推送會讓遠端變成和本機一樣，遠端多出來的提交會消失（使用 --force-with-lease，遠端在這期間又有人推送時會失敗）。',
      });
      if (c === 0) {
        await pullFlow();
        if (st.status && !st.status.state && !st.status.conflict.length) await pushFlow(opts);
      } else if (c === 1) {
        if (await confirmBox('確定要強制推送嗎？', '強制推送', { type: 'warning', detail: '遠端分支上本機沒有的提交會被移除，其他人的工作可能因此遺失。' })) await pushFlow({ ...opts, force: true });
      }
      return;
    }
    throw err;
  } finally {
    await refreshAll();
  }
}

async function addRemoteFlow(desc = '') {
  const remotes = (st.status && st.status.remotes) || [];
  const v = await form({
    title: '新增遠端',
    desc: desc || '遠端是另一個位置的儲存庫（例如 GitHub 上的專案），推送與拉取都透過它。',
    ok: '新增',
    fields: [
      { name: 'name', label: '名稱', value: remotes.some((r) => r.name === 'origin') ? '' : 'origin', help: '慣例上主要的遠端叫 origin' },
      { name: 'url', label: '網址', placeholder: 'https://github.com/使用者/專案.git' },
    ],
    validate: (x) => (!/^[A-Za-z0-9._-]+$/.test(x.name.trim()) ? '名稱只能有英數、. _ -' : !x.url.trim() ? '請輸入網址' : remotes.some((r) => r.name === x.name.trim()) ? '已經有同名的遠端' : ''),
  });
  if (!v) return false;
  await api('addRemote', { name: v.name.trim(), url: v.url.trim() });
  notice(`已新增遠端 ${v.name.trim()}`, 'ok');
  await refresh();
  return true;
}

/* ───────────── 標籤 ───────────── */

/** 推送一個標籤；name 為空時推送全部標籤。remote 為空時多個遠端讓使用者選 */
async function pushTagFlow(name, remote, { force = false } = {}) {
  const rs = (st.status && st.status.remotes) || [];
  if (!rs.length) { if (await addRemoteFlow('這個儲存庫還沒有設定遠端。')) await pushTagFlow(name, remote); return; }
  const rn = remote || defaultRemote();
  try {
    await api('pushTag', { name, remote: rn, force });
    if (st.remoteTags && st.remoteTags.remote === rn) {
      if (name) st.remoteTags.set.add(name); else for (const t of (st.branches || { tags: [] }).tags) st.remoteTags.set.add(t.name);
    }
    notice(name ? `已把標籤 ${name} 推送到 ${rn}` : `已把所有標籤推送到 ${rn}`, 'ok');
  } catch (err) {
    if (errInfo(err).code !== 'REJECTED' || force || !name) throw err;
    if (await confirmBox(`${rn} 已經有標籤 ${name}，而且指向不同的提交。要用本機的標籤取代嗎？`, '取代遠端標籤', { type: 'warning', detail: '其他人已經取得的舊標籤不會自動更新，建議改用新的標籤名稱。' })) await pushTagFlow(name, rn, { force: true });
  }
}

async function pushAllTagsFlow(btn) {
  const rs = (st.status && st.status.remotes) || [];
  if (rs.length > 1) {
    const items = [{ label: '推送所有標籤到' }, ...rs.map((r) => [r.name, () => pushTagFlow('', r.name)])];
    if (btn) menuBelow(btn, items); else popup(items, innerWidth / 2, innerHeight / 3);
    return;
  }
  await pushTagFlow('', rs[0] && rs[0].name);
}

/** 和遠端比對標籤：標示只在本機（還沒推送）與只在遠端的標籤 */
async function compareRemoteTags(remote) {
  const r = await api('remoteTags', { remote: remote || defaultRemote() });
  st.remoteTags = { remote: r.remote, set: new Set(r.tags) };
  const b = await ensureBranches();
  const local = new Set(b.tags.map((t) => t.name));
  const unpushed = b.tags.filter((t) => !st.remoteTags.set.has(t.name)).length;
  const remoteOnly = r.tags.filter((t) => !local.has(t)).length;
  notice(`${r.remote}：${unpushed} 個標籤還沒推送、${remoteOnly} 個只在遠端`, unpushed ? '' : 'ok');
  setSide('branches');
  renderBranches();
}

async function deleteTagFlow(name) {
  const rs = (st.status && st.status.remotes) || [];
  const rn = defaultRemote();
  const c = rs.length
    ? await choose(`刪除標籤 ${name}？`, ['只刪除本機', `本機與 ${rn} 都刪除`, '取消'], { type: 'warning', detail: `刪除 ${rn} 上的標籤後，其他人擷取時也看不到它（已經取得的人仍保留）。` })
    : (await confirmBox(`刪除本機標籤 ${name}？`, '刪除', { type: 'warning' }) ? 0 : 2);
  if (c === 2) return;
  await api('deleteTag', { name });
  if (c === 1) {
    if (st.remoteTags) st.remoteTags.set.delete(name);
    try { await api('deleteRemoteTag', { name, remote: rn }); } catch (err) {
      if (errInfo(err).code !== 'NO_REF') throw err;
      notice(`已刪除本機標籤；${rn} 上沒有這個標籤`);
    }
  }
  notice(c === 1 ? `已刪除標籤 ${name}（本機與 ${rn}）` : `已刪除本機標籤 ${name}`, 'ok');
  await refreshAll();
}

async function deleteRemoteTagFlow(name, rn) {
  if (!await confirmBox(`從 ${rn} 刪除標籤 ${name}？`, '刪除', { type: 'warning', detail: '本機的標籤會保留。其他人擷取時不會再看到它，但已經取得的人仍保留。' })) return;
  await api('deleteRemoteTag', { name, remote: rn });
  if (st.remoteTags && st.remoteTags.remote === rn) st.remoteTags.set.delete(name);
  notice(`已從 ${rn} 刪除標籤 ${name}`, 'ok');
  await refreshAll();
}

async function createTagFlow(hash) {
  const rs = (st.status && st.status.remotes) || [];
  const rn = defaultRemote();
  const fields = [{ name: 'name', label: '標籤名稱', placeholder: '例如：v1.0.0' }, { name: 'message', label: '說明（可省略；填寫時建立附註標籤）', type: 'textarea', rows: 2 }];
  if (rs.length) fields.push({ name: 'push', label: `建立後推送到 ${rn}`, type: 'checkbox', value: store.get('tagPush', false) });
  const v = await form({
    title: `在 ${hash ? hash.slice(0, 7) : '目前的提交'} 建立標籤`,
    ok: '建立',
    fields,
    validate: (x) => (!x.name.trim() ? '請輸入標籤名稱' : /\s/.test(x.name.trim()) ? '標籤名稱不能有空白' : ''),
  });
  if (!v) return;
  const name = v.name.trim();
  await api('createTag', { name, at: hash || undefined, message: v.message });
  if (rs.length) store.set('tagPush', !!v.push);
  if (v.push) await pushTagFlow(name, rn);
  else notice(`已建立標籤 ${name}（在「分支」分頁右鍵標籤可以推送）`, 'ok');
  await refreshAll();
}

function tagItems(name, hash) {
  const rs = (st.status && st.status.remotes) || [];
  return [
    hash ? ['切換到這個標籤（分離的 HEAD）', () => checkoutFlow({ commit: hash }, name)] : null,
    ['從這裡建立分支…', () => newBranchFlow(`refs/tags/${name}`, name)],
    ['在線圖中顯示', () => revealRef('tag', name)],
    ['複製名稱', () => copyText(name)],
    '-',
    ...rs.map((r) => [`推送到 ${r.name}`, () => pushTagFlow(name, r.name)]),
    ...rs.map((r) => [`推送所有標籤到 ${r.name}`, () => pushTagFlow('', r.name)]),
    '-',
    ['刪除標籤…', () => deleteTagFlow(name), { danger: true }],
    ...rs.map((r) => [`只從 ${r.name} 刪除…`, () => deleteRemoteTagFlow(name, r.name), { danger: true }]),
  ];
}

/* ───────────── 分支 ───────────── */

async function ensureBranches() {
  if (!st.branches) st.branches = await api('branches');
  return st.branches;
}

async function loadBranches() {
  const [b] = await Promise.all([api('branches'), loadExtras()]);
  st.branches = b;
  renderBranches();
}

async function checkoutFlow(target, label) {
  const r = await withStash('切換', () => api('checkout', target));
  if (r === null) return;
  for (const t of [...st.tabs]) if (t.kind === 'diff' && t.src.kind === 'work') closeTab(t.id, true);
  notice(`已切換到 ${label || r}`, 'ok');
  await refreshAll();
}

async function newBranchFlow(from, fromLabel) {
  const v = await form({
    title: '建立分支',
    desc: from ? `從 ${fromLabel || from} 建立新分支。` : `從目前的位置（${st.status && st.status.branch ? st.status.branch : 'HEAD'}）建立新分支。`,
    ok: '建立',
    fields: [
      { name: 'name', label: '分支名稱', placeholder: '例如：feature/login' },
      { name: 'checkout', label: '建立後切換到新分支', type: 'checkbox', value: true },
    ],
    validate: (x) => (!x.name.trim() ? '請輸入分支名稱' : /\s/.test(x.name.trim()) ? '分支名稱不能有空白' : ''),
  });
  if (!v) return;
  await api('createBranch', { name: v.name.trim(), from, checkout: v.checkout });
  notice(`已建立分支 ${v.name.trim()}`, 'ok');
  await refreshAll();
}

async function mergeFlow(ref) {
  const cur = st.status.branch;
  if (!ref) {
    const b = await ensureBranches();
    const items = [{ label: `合併到目前分支 ${cur || 'HEAD'}` }];
    for (const x of b.local) if (!x.current) items.push([x.name, () => mergeFlow(x.name)]);
    if (b.remote.length) items.push('-', { label: '遠端分支' });
    for (const x of b.remote.slice(0, 30)) items.push([x.name, () => mergeFlow(x.name)]);
    if (items.length === 1) { notice('沒有其他分支可以合併'); return; }
    menuBelow($('[data-act="mergeInto"]'), items);
    return;
  }
  if (!await confirmBox(`把 ${ref} 合併到 ${cur || 'HEAD'}？`, '合併', { detail: '有衝突時會停在合併中的狀態，可以逐一解決或中止合併。' })) return;
  const r = await withStash('合併', () => api('merge', { ref }));
  if (!r) { await refreshAll(); return; }
  if (r.conflict) { await onConflict(r); return; }
  notice(/Already up.to.date/i.test(r.output) ? `${ref} 已經合併過了` : `已把 ${ref} 合併到 ${cur}`, 'ok');
  await refreshAll();
}

async function deleteBranchFlow(name) {
  if (!await confirmBox(`刪除本機分支 ${name}？`, '刪除', { type: 'warning' })) return;
  try {
    await api('deleteBranch', { name });
  } catch (err) {
    if (errInfo(err).code !== 'NOT_MERGED') throw err;
    if (!await confirmBox(`${name} 還有沒合併到其他分支的提交，仍要刪除嗎？`, '強制刪除', { type: 'warning', detail: '刪除後這些提交不屬於任何分支，之後很難找回。' })) return;
    await api('deleteBranch', { name, force: true });
  }
  notice(`已刪除分支 ${name}`, 'ok');
  await refreshAll();
}

async function branchMenu(btn) {
  const b = await ensureBranches();
  const items = [{ label: '切換到分支' }];
  for (const x of b.local.slice(0, 40)) items.push([`${x.current ? '● ' : '　'}${x.name}`, () => (x.current ? null : checkoutFlow({ branch: x.name }, x.name)), { disabled: x.current }]);
  const localNames = new Set(b.local.map((x) => x.name));
  const remoteOnly = b.remote.filter((x) => !localNames.has(x.name.slice(x.name.indexOf('/') + 1)));
  if (remoteOnly.length) {
    items.push('-', { label: '遠端分支（建立本機分支並切換）' });
    for (const x of remoteOnly.slice(0, 30)) items.push([`　${x.name}`, () => checkoutFlow({ remote: x.name }, x.name)]);
  }
  items.push('-', ['＋ 建立分支…', () => newBranchFlow()], ['管理分支…', () => setSide('branches')]);
  menuBelow(btn, items);
}

function renderBranches() {
  const b = st.branches;
  const box = $('#branches');
  if (!b) { box.innerHTML = '<div class="empty-msg">讀取中…</div>'; return; }
  const s = st.status || {};
  const q = st.brFilter.trim().toLowerCase();
  const hit = (n) => !q || n.toLowerCase().includes(q);
  const out = [];
  const grp = (key, title, n, acts = '') => {
    if (q && !n) return false;
    const closed = st.collapsed.has(key) && !q;
    out.push(`<div class="grp-h" data-grp="${key}"><span class="tw">${closed ? '▸' : '▾'}</span>${title}<span class="n">${n}</span><span class="acts">${acts}</span></div>`);
    return !closed;
  };
  const label = (name) => (q ? name : basename(name));
  const localRow = (x, depth) => {
    const ab = [x.ahead ? `↑${x.ahead}` : '', x.behind ? `↓${x.behind}` : '', x.gone ? '遠端已刪除' : ''].filter(Boolean).join(' ');
    return `<div class="row${x.current ? ' cur' : ''}" data-kind="local" data-name="${esc(x.name)}" style="padding-left:${10 + depth * 14}px" title="${esc(`${x.name}${x.upstream ? `\n追蹤 ${x.upstream}` : '\n沒有追蹤的遠端分支'}\n${x.hash} ${x.subject}\n雙擊切換`)}">`
      + `<span class="ic">${x.current ? '●' : '⎇'}</span><span class="nm">${esc(label(x.name))}</span><span class="meta">${esc(ab)}</span></div>`;
  };
  const remoteRow = (x, depth) => `<div class="row" data-kind="remote" data-name="${esc(x.name)}" style="padding-left:${10 + depth * 14}px" title="${esc(`${x.name}\n${x.hash} ${x.subject}\n雙擊建立本機分支並切換`)}"><span class="ic">☁</span><span class="nm">${esc(label(x.name))}</span><span class="meta">${esc(C.ago(x.time))}</span></div>`;
  const count = (n) => n.items.length + n.dirs.reduce((t, c) => t + count(c), 0);
  /** 依「/」分資料夾；篩選時改成平面清單 */
  const tree = (kind, list, rowFn) => {
    if (q) { for (const x of list.filter((y) => hit(y.name))) out.push(rowFn(x, 0)); return; }
    const walk = (node, depth) => {
      for (const d of node.dirs) {
        const k = `bf:${kind}:${d.path}`;
        const closed = st.collapsed.has(k);
        out.push(`<div class="row bdir" data-fold="${esc(k)}" style="padding-left:${2 + depth * 14}px" title="${esc(d.path)}/"><span class="tw">${closed ? '▸' : '▾'}</span><span class="ic">📁</span><span class="nm">${esc(d.name)}</span><span class="meta">${count(d)}</span></div>`);
        if (!closed) walk(d, depth + 1);
      }
      for (const x of node.items) out.push(rowFn(x, depth));
    };
    walk(C.buildTree(list, (x) => x.name), 0);
  };
  const locals = b.local.filter((x) => hit(x.name));
  if (grp('b:local', '本機分支', locals.length, '<button class="ib sm" data-bact="new" title="建立分支">＋</button>')) tree('local', b.local, localRow);
  const remotes = b.remote.filter((x) => hit(x.name));
  if (b.remote.length && grp('b:remote', '遠端分支', remotes.length, '<button class="ib sm" data-bact="fetch" title="擷取">⟳</button>')) tree('remote', b.remote, remoteRow);
  const tags = b.tags.filter((x) => hit(x.name));
  const rt = st.remoteTags && (s.remotes || []).some((r) => r.name === st.remoteTags.remote) ? st.remoteTags : null;
  const localTags = new Set(b.tags.map((x) => x.name));
  const remoteOnly = rt ? [...rt.set].filter((n) => !localTags.has(n) && hit(n)) : [];
  const hasRemote = (s.remotes || []).length;
  const tagActs = `${hasRemote ? '<button class="ib sm" data-bact="cmpTags" title="和遠端比對，標示還沒推送的標籤（需要連線）">⇄</button><button class="ib sm" data-bact="pushTags" data-menu title="推送所有標籤">⇡</button>' : ''}<button class="ib sm" data-bact="newTag" title="在目前的提交建立標籤">＋</button>`;
  if (grp('b:tags', '標籤', tags.length + remoteOnly.length, tagActs)) {
    if (!b.tags.length && !remoteOnly.length && !q) out.push('<div class="empty-msg">還沒有標籤。在線圖右鍵提交，或按上面的「＋」建立。</div>');
    for (const x of tags) {
      const un = rt && !rt.set.has(x.name);
      out.push(`<div class="row" data-kind="tag" data-name="${esc(x.name)}" title="${esc(`${x.name}\n${x.hash} ${x.subject}${un ? `\n還沒推送到 ${rt.remote}` : ''}`)}"><span class="ic">🏷</span><span class="nm">${esc(x.name)}</span>${un ? '<span class="pill">未推送</span>' : ''}<span class="meta">${esc(x.hash)}</span></div>`);
    }
    for (const n of remoteOnly) out.push(`<div class="row" data-kind="rtag" data-name="${esc(n)}" title="${esc(`${n}\n只在 ${rt.remote}，本機沒有（擷取後會出現）`)}"><span class="ic">☁</span><span class="nm">${esc(n)}</span><span class="pill dim">只在遠端</span></div>`);
  }
  const subs = (st.subs || []).filter((x) => hit(x.path));
  if (subs.length && grp('b:subs', '子模組', subs.length, '<button class="ib sm" data-bact="subUpdate" title="初始化並更新所有子模組（submodule update --init --recursive）">⟳</button>')) {
    const SUB = { ok: ['◆', ''], uninit: ['◇', '尚未初始化'], changed: ['◆', '指向的提交不同'], conflict: ['!', '衝突'] };
    for (const x of subs) out.push(`<div class="row" data-kind="sub" data-name="${esc(x.path)}" title="${esc(`${x.path}\n${x.hash.slice(0, 10)}${x.describe ? `（${x.describe}）` : ''}${SUB[x.state][1] ? `\n${SUB[x.state][1]}` : ''}`)}"><span class="ic">${SUB[x.state][0]}</span><span class="nm">${esc(x.path)}</span>${SUB[x.state][1] ? `<span class="pill${x.state === 'uninit' ? ' dim' : ''}">${SUB[x.state][1]}</span>` : ''}<span class="meta">${esc(x.hash.slice(0, 7))}</span></div>`);
  }
  const wts = (st.worktrees || []).filter((x) => hit(x.path) || hit(x.branch || ''));
  if (!q && (st.worktrees || []).length > 1 && grp('b:wts', '工作樹', wts.length, '<button class="ib sm" data-bact="wtAdd" title="新增工作樹">＋</button>')) {
    for (const w of wts) out.push(`<div class="row${w.current ? ' cur' : ''}" data-kind="wt" data-name="${esc(w.path)}" title="${esc(`${w.path}${w.main ? '\n主要的工作樹' : ''}${w.current ? '\n目前開啟的' : '\n雙擊開啟'}`)}"><span class="ic">${w.current ? '●' : '▣'}</span><span class="nm">${esc(w.branch || (w.detached ? `（分離）${(w.hash || '').slice(0, 7)}` : basename(w.path)))}</span><span class="dir">${esc(w.path)}</span></div>`);
  }
  const rlist = s.remotes || [];
  if (!q && grp('b:remotes', '遠端', rlist.length, '<button class="ib sm" data-bact="addRemote" title="新增遠端">＋</button>')) {
    if (!rlist.length) out.push('<div class="empty-msg">還沒有設定遠端。<br><button class="secondary sm" data-bact="addRemote">＋ 新增遠端…</button></div>');
    for (const r of rlist) out.push(`<div class="row" data-kind="remoteRepo" data-name="${esc(r.name)}" title="${esc(r.url)}"><span class="ic">⇅</span><span class="nm">${esc(r.name)}</span><span class="dir">${esc(r.url)}</span></div>`);
  }
  if (q && !locals.length && !remotes.length && !tags.length) out.push('<div class="empty-msg">沒有符合篩選的分支或標籤。</div>');
  box.innerHTML = out.join('');
}

/** 分支、遠端分支、標籤、遠端的右鍵選單（側欄與線圖上的標記共用） */
function refItems(kind, name, { hash = '' } = {}) {
  const b = st.branches || { local: [], remote: [], tags: [] };
  const cur = st.status && st.status.branch;
  if (kind === 'local') {
    const x = b.local.find((y) => y.name === name);
    const isCur = name === cur;
    return [
      ['切換到這個分支', () => checkoutFlow({ branch: name }, name), { disabled: isCur }],
      [`合併到目前分支（${cur || 'HEAD'}）`, () => mergeFlow(name), { disabled: isCur }],
      [`把目前分支重定基底到 ${name}…`, () => rebaseOntoFlow(name), { disabled: isCur || !cur }],
      ['與目前分支比較', () => compareRangeFlow({ hash: st.status.head.hash, label: cur || 'HEAD' }, { hash: x.hash, label: name }), { disabled: isCur || !x || !(st.status && st.status.head) }],
      ['從這裡建立分支…', () => newBranchFlow(name)],
      ['在線圖中顯示', () => revealRef(kind, name)],
      '-',
      isCur ? ['推送…', () => pushDialog()] : null,
      ['重新命名…', async () => {
        const n = await ask(`重新命名分支 ${name}`, name, { validate: (v) => (!v.trim() ? '名稱不能是空的' : /\s/.test(v.trim()) ? '分支名稱不能有空白' : '') });
        if (n && n !== name) { await api('renameBranch', { from: name, to: n }); await refreshAll(); }
      }],
      ['複製名稱', () => copyText(name)],
      x && x.upstream ? ['複製追蹤的遠端分支名稱', () => copyText(x.upstream)] : null,
      '-',
      ['刪除分支…', () => deleteBranchFlow(name), { danger: true, disabled: isCur }],
    ];
  }
  if (kind === 'remote') {
    return [
      ['切換（建立本機分支並追蹤）', () => checkoutFlow({ remote: name }, name)],
      [`合併到目前分支（${cur || 'HEAD'}）`, () => mergeFlow(name)],
      [`把目前分支重定基底到 ${name}…`, () => rebaseOntoFlow(name), { disabled: !cur }],
      ['與目前分支比較', () => compareRangeFlow({ hash: st.status.head.hash, label: cur || 'HEAD' }, { hash: (b.remote.find((z) => z.name === name) || {}).hash, label: name }), { disabled: !(st.status && st.status.head) }],
      ['從這裡建立分支…', () => newBranchFlow(name)],
      ['在線圖中顯示', () => revealRef(kind, name)],
      ['複製名稱', () => copyText(name)],
      '-',
      ['刪除遠端分支…', async () => {
        if (!await confirmBox(`刪除遠端的分支 ${name}？`, '刪除', { type: 'warning', detail: '會從遠端伺服器上刪除，其他人也會看不到這個分支。' })) return;
        await api('deleteRemoteBranch', { remote: name });
        notice(`已刪除遠端分支 ${name}`, 'ok');
        await refreshAll();
      }, { danger: true }],
    ];
  }
  if (kind === 'tag') {
    const t = b.tags.find((y) => y.name === name);
    return tagItems(name, hash || (t && t.hash));
  }
  if (kind === 'sub') {
    const x = (st.subs || []).find((y) => y.path === name) || {};
    return [
      [x.state === 'uninit' ? '初始化並下載' : '更新到記錄的版本', () => submoduleUpdateFlow(name)],
      x.state !== 'uninit' ? ['開啟這個子模組', () => openRepoAt(`${repo().root}/${name}`, basename(name))] : null,
      ['複製路徑', () => copyText(name)],
    ];
  }
  if (kind === 'wt') {
    const w = (st.worktrees || []).find((y) => y.path === name) || {};
    return [
      ['開啟這個工作樹', () => openRepoAt(name, basename(name)), { disabled: w.current }],
      ['在檔案管理員中顯示', () => td.shell.showItemInFolder(name)],
      ['複製路徑', () => copyText(name)],
      '-',
      ['移除工作樹…', () => removeWorktreeFlow(w), { danger: true, disabled: w.main || w.current }],
    ];
  }
  if (kind === 'rtag') {
    const rn = st.remoteTags ? st.remoteTags.remote : defaultRemote();
    return [
      ['擷取（取得遠端的標籤）', () => fetchFlow()],
      ['複製名稱', () => copyText(name)],
      '-',
      [`從 ${rn} 刪除這個標籤…`, () => deleteRemoteTagFlow(name, rn), { danger: true }],
    ];
  }
  if (kind === 'remoteRepo') {
    const r = st.status.remotes.find((y) => y.name === name);
    return [
      ['複製網址', () => copyText(r.url)],
      ['擷取', () => fetchFlow()],
      ['擷取並刪除遠端已不存在的標籤…', async () => {
        if (await confirmBox('擷取並刪除本機上、遠端已經不存在的標籤？', '擷取並清除', { detail: '只在本機、還沒推送的標籤也會被刪除。要保留的請先推送。' })) await fetchFlow({ pruneTags: true });
      }],
      ['推送所有標籤到這裡', () => pushTagFlow('', name)],
      ['比對遠端標籤', () => compareRemoteTags(name)],
      '-',
      ['移除遠端…', async () => {
        if (!await confirmBox(`移除遠端 ${name}？`, '移除', { type: 'warning', detail: '只會移除本機的設定與遠端分支的紀錄，不會影響遠端伺服器上的儲存庫。' })) return;
        await api('removeRemote', { name });
        await refreshAll();
      }, { danger: true }],
    ];
  }
  return [];
}

function initBranches() {
  const box = $('#branches');
  $('#brFilter').addEventListener('input', (e) => { st.brFilter = e.target.value; renderBranches(); });
  box.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-bact]');
    if (a) {
      ev.stopPropagation();
      const fn = { new: () => newBranchFlow(), fetch: () => fetchFlow(), cmpTags: () => compareRemoteTags(), subUpdate: () => submoduleUpdateFlow(), wtAdd: () => addWorktreeFlow(), pushTags: () => pushAllTagsFlow(a), newTag: () => createTagFlow(''), addRemote: () => addRemoteFlow() }[a.dataset.bact];
      if (fn) Promise.resolve(fn()).catch(fail);
      return;
    }
    const h = ev.target.closest('.grp-h');
    const f = ev.target.closest('.bdir');
    if (h || f) {
      const k = h ? h.dataset.grp : f.dataset.fold;
      if (st.collapsed.has(k)) st.collapsed.delete(k); else st.collapsed.add(k);
      renderBranches();
      return;
    }
    const row = ev.target.closest('.row[data-kind]');
    if (!row) return;
    for (const r of $$('.row.sel', box)) r.classList.remove('sel');
    row.classList.add('sel');
    const { kind, name } = row.dataset;
    if (kind === 'local' || kind === 'remote' || kind === 'tag') revealRef(kind, name);
  });
  box.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('.row[data-kind]');
    if (!row) return;
    const { kind, name } = row.dataset;
    if (kind === 'local' && !row.classList.contains('cur')) checkoutFlow({ branch: name }, name).catch(fail);
    else if (kind === 'remote') checkoutFlow({ remote: name }, name).catch(fail);
    else if (kind === 'wt' && !row.classList.contains('cur')) openRepoAt(name, basename(name)).catch(fail);
    else if (kind === 'sub') openRepoAt(`${repo().root}/${name}`, basename(name)).catch(fail);
  });
  box.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row[data-kind]');
    if (!row) return;
    contextMenu(ev, refItems(row.dataset.kind, row.dataset.name));
  });
}

/** 在線圖中選取分支或標籤所在的提交 */
function revealRef(kind, name) {
  const g = graphTab();
  activate(g.id);
  const commits = (st.log && st.log.commits) || [];
  const type = kind === 'tag' ? 'tag' : kind;
  const i = commits.findIndex((c) => c.refs.some((r) => r.type === type && r.name === name));
  if (i < 0) { notice(`${name} 不在目前載入的線圖中`); return; }
  g.view.select(i, { scroll: true });
}

/* ───────────── 儲藏 ───────────── */

async function stashFlow() {
  const s = st.status;
  if (s && !s.staged.length && !s.unstaged.length && !s.untracked.length) { notice('沒有可以儲藏的變更'); return; }
  const v = await form({
    title: '儲藏目前的變更（stash）',
    desc: '把還沒提交的變更暫時收起來，工作目錄回到乾淨的狀態；之後可以在「儲藏」分頁取回。',
    ok: '儲藏',
    fields: [
      { name: 'message', label: '說明（可省略）', placeholder: '例如：登入頁改到一半' },
      { name: 'untracked', label: '包含未追蹤的檔案', type: 'checkbox', value: true },
    ],
  });
  if (!v) return;
  await api('stash', { message: v.message, untracked: v.untracked });
  notice('已儲藏變更', 'ok');
  await refreshAll();
}

function renderStashes() {
  const n = st.stashes.length;
  $('#stashCount').hidden = !n;
  $('#stashCount').textContent = String(n);
  const box = $('#stashes');
  if (!n) { box.innerHTML = '<div class="empty-msg">沒有儲藏的變更。<br>需要暫時切到其他分支、又不想提交做到一半的東西時，可以先儲藏起來。</div>'; return; }
  box.innerHTML = st.stashes.map((x) => `<div class="row" data-ref="${esc(x.ref)}" title="${esc(`${x.ref}\n${x.subject}\n${C.formatDate(x.time)}`)}">`
    + `<span class="ic">⤓</span><span class="nm">${esc(x.subject.replace(/^(On|WIP on) [^:]+: /, ''))}</span><span class="dir">${esc(C.ago(x.time))}</span>`
    + '<span class="acts"><button class="ib sm" data-sact="apply" title="套用（保留這筆儲藏）">⎘</button><button class="ib sm" data-sact="pop" title="取出（套用後刪除）">⤒</button><button class="ib sm" data-sact="drop" title="刪除">🗑</button></span></div>').join('');
}

async function stashAction(act, ref) {
  if (act === 'drop') {
    if (!await confirmBox(`刪除儲藏 ${ref}？`, '刪除', { type: 'warning', detail: '刪除後無法復原。' })) return;
    await api('stash:drop', { ref });
    notice('已刪除儲藏', 'ok');
  } else {
    const r = await api('stash:apply', { ref, pop: act === 'pop' });
    if (r.conflict) { await onConflict(r); return; }
    notice(act === 'pop' ? '已取出儲藏的變更' : '已套用儲藏的變更', 'ok');
  }
  await refreshAll();
}

async function showStash(ref) {
  const x = st.stashes.find((y) => y.ref === ref);
  const info = await api('stash:files', { ref });
  const g = graphTab();
  activate(g.id);
  g.view.showDetail({
    title: `儲藏 ${ref}`,
    message: x ? x.subject : '',
    rows: [['時間', x ? C.formatDate(x.time) : ''], ['基於', info.parent.slice(0, 10)]],
    files: info.files,
    openFile: (f) => openDiff({ kind: 'commit', hash: info.hash, parent: info.parent, untrackedHash: info.untrackedHash, path: f.path, orig: f.orig, status: f.status, label: f.label, title: `${basename(f.path)}（${ref}）` }),
    actions: [['套用', () => stashAction('apply', ref)], ['取出', () => stashAction('pop', ref)]],
  });
}

function initStashes() {
  const box = $('#stashes');
  box.addEventListener('click', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const b = ev.target.closest('[data-sact]');
    if (b) { ev.stopPropagation(); stashAction(b.dataset.sact, row.dataset.ref).catch(fail); return; }
    for (const r of $$('.row.sel', box)) r.classList.remove('sel');
    row.classList.add('sel');
    showStash(row.dataset.ref).catch(fail);
  });
  box.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.row');
    if (!row) return;
    const ref = row.dataset.ref;
    contextMenu(ev, [
      ['查看內容', () => showStash(ref)],
      ['套用（保留這筆儲藏）', () => stashAction('apply', ref)],
      ['取出（套用後刪除）', () => stashAction('pop', ref)],
      '-',
      ['刪除…', () => stashAction('drop', ref), { danger: true }],
    ]);
  });
}

/* ───────────── 分頁 ───────────── */

function renderTabs() {
  $('#tabs').innerHTML = st.tabs.map((t) => `<div class="tab${t.id === st.active ? ' on' : ''}${t.fixed ? ' fixed' : ''}" data-id="${t.id}" title="${esc(t.tip || t.title)}">`
    + `<span class="tn"${t.preview ? ' style="font-style:italic"' : ''}>${esc(t.title)}</span>${t.fixed ? '' : '<button class="x" title="關閉">✕</button>'}</div>`).join('');
}

function addTab(t) {
  t.id = `t${++st.seq}`;
  st.tabs.push(t);
  $('#stage').append(t.view.el);
  activate(t.id);
  return t;
}

function activate(id) {
  st.active = id;
  for (const t of st.tabs) t.view.el.hidden = t.id !== id || !repo();
  renderTabs();
  const t = st.tabs.find((x) => x.id === id);
  if (t && t.view.onShow) t.view.onShow();
}

function closeTab(id, silent) {
  const i = st.tabs.findIndex((t) => t.id === id);
  if (i < 0 || st.tabs[i].fixed) return;
  const [t] = st.tabs.splice(i, 1);
  t.view.el.remove();
  if (st.active === id) {
    const next = st.tabs[Math.min(i, st.tabs.length - 1)] || st.tabs[0];
    if (next) activate(next.id);
  } else if (!silent) renderTabs();
  renderTabs();
}

function graphTab() { return st.tabs.find((t) => t.kind === 'graph'); }

function initTabs() {
  const box = $('#tabs');
  box.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    if (e.target.closest('.x')) closeTab(tab.dataset.id);
    else activate(tab.dataset.id);
  });
  box.addEventListener('dblclick', (e) => {
    const tab = e.target.closest('.tab');
    const t = tab && st.tabs.find((x) => x.id === tab.dataset.id);
    if (t && t.preview) { t.preview = false; renderTabs(); }
  });
  box.addEventListener('auxclick', (e) => {
    const tab = e.target.closest('.tab');
    if (tab && e.button === 1) closeTab(tab.dataset.id);
  });
}

/* ───────────── 線圖 ───────────── */

async function loadLog({ more = false } = {}) {
  const limit = Math.max(50, Number(setting('logLimit', 300)) || 300);
  st.logLimit = more ? st.logLimit + limit : Math.max(st.logLimit, limit);
  const r = await api('log', { limit: st.logLimit, all: st.graphAll, search: st.search || undefined });
  st.log = r;
  const g = graphTab();
  if (g) g.view.render();
}

class GraphView {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'view graph';
    this.el.innerHTML = '<div class="ghead"><label class="chk" title="顯示所有分支，或只顯示目前分支的歷史"><input type="checkbox" class="all"> 所有分支</label>'
      + '<span class="cnt"></span><span class="sp"></span>'
      + '<select class="qm" title="搜尋方式"><option value="">篩選已載入的提交</option><option value="message">搜尋全部歷史的訊息</option><option value="author">搜尋全部歷史的作者</option><option value="content">搜尋檔案內容的變更（-S）</option></select>'
      + '<input type="search" class="q" placeholder="搜尋訊息、作者、提交編號" spellcheck="false"></div>'
      + '<div class="gsplit"><div class="glist" tabindex="0"></div><div class="dsplit" hidden></div><div class="detail" hidden></div></div>';
    this.list = $('.glist', this.el);
    this.detail = $('.detail', this.el);
    this.sel = -1;
    this.detailHash = '';
    $('.all', this.el).checked = st.graphAll;
    $('.all', this.el).onchange = (e) => { st.graphAll = e.target.checked; store.set('graphAll', st.graphAll); loadLog().catch(fail); };
    $('.q', this.el).oninput = () => {
      if (!$('.qm', this.el).value) { this.applyFilter(); return; }
      // 在 git 端搜尋：清空時回到完整的線圖
      if (!$('.q', this.el).value.trim() && st.search) { st.search = null; loadLog().catch(fail); }
    };
    $('.q', this.el).onkeydown = (e) => { if (e.key === 'Enter' && $('.qm', this.el).value) this.runSearch(); };
    $('.qm', this.el).onchange = () => {
      const m = $('.qm', this.el).value;
      $('.q', this.el).placeholder = m ? { message: '輸入後按 Enter 搜尋提交訊息', author: '輸入後按 Enter 搜尋作者名稱或 email', content: '輸入後按 Enter：找出新增或刪除這段文字的提交' }[m] : '搜尋訊息、作者、提交編號';
      if (!m) { if (st.search) { st.search = null; loadLog().catch(fail); } this.applyFilter(); } else if ($('.q', this.el).value.trim()) this.runSearch();
    };
    this.list.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) { loadLog({ more: true }).catch(fail); return; }
      const row = e.target.closest('.crow');
      if (row) this.select(Number(row.dataset.i));
    });
    this.list.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.crow');
      if (!row) return;
      const c = st.log.commits[Number(row.dataset.i)];
      this.select(Number(row.dataset.i));
      // 在分支或標籤的標記上右鍵：那個參照的選單
      const ref = e.target.closest('.ref[data-ref]');
      if (ref) {
        const [type, ...rest] = ref.dataset.ref.split(':');
        const name = rest.join(':');
        if (type === 'local' || type === 'remote' || type === 'tag') {
          e.preventDefault();
          e.stopPropagation();
          const x = e.clientX, y = e.clientY;
          ensureBranches().then(() => popup([{ label: `${type === 'tag' ? '標籤' : type === 'remote' ? '遠端分支' : '分支'} ${name}` }, ...refItems(type, name, { hash: c.hash })], x, y)).catch(fail);
          return;
        }
      }
      contextMenu(e, commitMenu(c));
    });
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = st.log ? st.log.commits.length : 0;
        if (n) this.select(Math.max(0, Math.min(n - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1))), { scroll: true });
      } else if (e.key === 'Escape') this.closeDetail();
    });
    this.detail.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dact]');
      if (b && b.dataset.dact === 'close') { this.closeDetail(); return; }
      if (b && this.detailActs) { const fn = this.detailActs[Number(b.dataset.dact)]; if (fn) Promise.resolve(fn()).catch(fail); return; }
      const h = e.target.closest('[data-hash]');
      if (h) { const i = st.log.commits.findIndex((c) => c.hash === h.dataset.hash); if (i >= 0) this.select(i, { scroll: true }); return; }
      const f = e.target.closest('.row[data-fi]');
      if (f && this.openFile) {
        for (const r of $$('.row.sel', this.detail)) r.classList.remove('sel');
        f.classList.add('sel');
        this.openFile(this.files[Number(f.dataset.fi)]);
      }
    });
    // 拖曳調整內容面板高度
    const split = $('.dsplit', this.el);
    split.addEventListener('mousedown', (e) => {
      e.preventDefault();
      split.classList.add('drag');
      const box = $('.gsplit', this.el).getBoundingClientRect();
      const move = (ev) => { this.detail.style.height = `${Math.max(120, Math.min(box.height - 120, box.bottom - ev.clientY))}px`; };
      const up = () => { split.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('detailH', this.detail.style.height); };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    const h = store.get('detailH', '');
    if (h) this.detail.style.height = h;
  }

  render() {
    const log = st.log;
    if (!log) { this.list.innerHTML = '<div class="dnote">讀取中…</div>'; return; }
    const commits = log.commits;
    if (!commits.length) {
      this.list.innerHTML = '<div class="dnote">還沒有任何提交。暫存檔案並提交後，歷史會顯示在這裡。</div>';
      $('.cnt', this.el).textContent = '';
      this.closeDetail();
      return;
    }
    const L = C.layoutGraph(commits);
    const W = L.width * LANE + 12;
    const cx = (c) => 10 + c * LANE;
    const cy = (y) => y * ROW;
    const paths = new Map();
    for (const e of L.edges) {
      const x1 = cx(e.x1), y1 = cy(e.y1), x2 = cx(e.x2), y2 = cy(e.y2);
      const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      const k = e.color % 8;
      paths.set(k, (paths.get(k) || '') + d);
    }
    const headHash = st.status && st.status.head ? st.status.head.hash : '';
    let svg = `<svg width="${W}" height="${commits.length * ROW}" xmlns="http://www.w3.org/2000/svg">`;
    for (const [k, d] of paths) svg += `<path d="${d}" fill="none" stroke-width="2" style="stroke:var(--l${k})"/>`;
    L.nodes.forEach((n, i) => {
      const x = cx(n.col), y = cy(i + 0.5);
      const col = `var(--l${n.color % 8})`;
      if (commits[i].hash === headHash) svg += `<circle cx="${x}" cy="${y}" r="6" style="fill:var(--bg);stroke:${col}" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="2.5" style="fill:${col}"/>`;
      else if (n.merge) svg += `<circle cx="${x}" cy="${y}" r="4" style="fill:var(--bg);stroke:${col}" stroke-width="2"/>`;
      else svg += `<circle cx="${x}" cy="${y}" r="4" style="fill:${col}"/>`;
    });
    svg += '</svg>';
    const rows = commits.map((c, i) => {
      const refs = c.refs.map((r) => {
        if (r.type === 'head') return '<span class="ref headref" title="分離的 HEAD">HEAD</span>';
        const icon = r.type === 'tag' ? '🏷 ' : r.type === 'remote' ? '☁ ' : '';
        const tip = r.type === 'local' ? (r.head ? `目前分支 ${r.name}` : `本機分支 ${r.name}（雙擊切換）`) : r.type === 'remote' ? `遠端分支 ${r.name}` : r.type === 'tag' ? `標籤 ${r.name}` : r.name;
        return `<span class="ref ${r.type}${r.head ? ' head' : ''}" data-ref="${esc(r.type)}:${esc(r.name)}" title="${esc(tip)}">${icon}${esc(r.name)}</span>`;
      }).join('');
      return `<div class="crow${i === this.sel ? ' sel' : ''}${c.hash === headHash ? ' head' : ''}" data-i="${i}"><span class="gpad" style="width:${W}px"></span>${refs}`
        + `<span class="subj" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="who" title="${esc(`${c.author} <${c.email}>`)}">${esc(c.author)}</span>`
        + `<span class="when" title="${esc(C.formatDate(c.time))}">${esc(C.ago(c.time))}</span><span class="sha">${esc(c.hash.slice(0, 7))}</span></div>`;
    }).join('');
    const top = this.list.scrollTop;
    this.list.innerHTML = svg + rows + (log.more ? '<div class="gmore"><button class="secondary sm" data-more>載入更多提交…</button></div>' : '');
    this.list.scrollTop = top;
    $('.cnt', this.el).textContent = `${commits.length}${log.more ? '+' : ''} 個提交`;
    this.list.ondblclick = (e) => {
      const ref = e.target.closest('.ref[data-ref]');
      if (!ref) return;
      const [type, ...rest] = ref.dataset.ref.split(':');
      const name = rest.join(':');
      if (type === 'local' && !ref.classList.contains('head')) checkoutFlow({ branch: name }, name).catch(fail);
      else if (type === 'remote') checkoutFlow({ remote: name }, name).catch(fail);
    };
    this.applyFilter();
    // 內容面板中的提交仍存在時保留
    if (this.detailHash) {
      const i = commits.findIndex((c) => c.hash === this.detailHash);
      if (i >= 0) { this.sel = i; this.markSel(); } else if (!this.detailKeep) this.closeDetail();
    }
  }

  runSearch() {
    const text = $('.q', this.el).value.trim();
    st.search = text ? { mode: $('.qm', this.el).value, text } : null;
    for (const r of $$('.crow.dim', this.list)) r.classList.toggle('dim', false);
    loadLog().then(() => { if (st.search) notice(`找到 ${st.log.commits.length}${st.log.more ? '+' : ''} 個符合的提交`); }).catch(fail);
  }

  applyFilter() {
    if (st.search) { $('.cnt', this.el).textContent = `搜尋結果：${st.log ? st.log.commits.length : 0}${st.log && st.log.more ? '+' : ''} 個提交`; return; }
    const q = $('.q', this.el).value.trim().toLowerCase();
    const commits = st.log ? st.log.commits : [];
    let hits = 0;
    for (const row of $$('.crow', this.list)) {
      const c = commits[Number(row.dataset.i)];
      const hit = !q || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q));
      row.classList.toggle('dim', !hit);
      if (hit) hits++;
    }
    if (q) $('.cnt', this.el).textContent = `符合 ${hits} 個`;
  }

  markSel() {
    for (const r of $$('.crow.sel', this.list)) r.classList.remove('sel');
    const row = $(`.crow[data-i="${this.sel}"]`, this.list);
    if (row) row.classList.add('sel');
    return row;
  }

  select(i, { scroll = false } = {}) {
    const c = st.log && st.log.commits[i];
    if (!c) return;
    this.sel = i;
    const row = this.markSel();
    if (scroll && row) {
      const top = row.offsetTop;
      if (top < this.list.scrollTop || top > this.list.scrollTop + this.list.clientHeight - ROW * 2) this.list.scrollTop = Math.max(0, top - this.list.clientHeight / 3);
    }
    this.showCommit(c.hash).catch(fail);
  }

  async showCommit(hash) {
    this.detailHash = hash;
    this.detailKeep = false;
    const info = await api('commit:info', { hash });
    if (this.detailHash !== hash) return;
    const parents = info.parents.map((p) => `<a class="mono" data-hash="${esc(p)}">${esc(p.slice(0, 10))}</a>`).join('、') || '（無，第一個提交）';
    this.showDetail({
      title: info.message.split('\n')[0],
      message: info.message,
      rows: [
        ['提交', `<span class="mono">${esc(info.hash)}</span>`, true],
        ['作者', `${esc(info.author)} &lt;${esc(info.email)}&gt;・${esc(C.formatDate(info.time))}`, true],
        info.committer !== info.author || info.committerEmail !== info.email ? ['提交者', `${esc(info.committer)}・${esc(C.formatDate(info.commitTime))}`, true] : null,
        ['父提交', parents, true],
        info.refs.length ? ['參照', info.refs.map((r) => esc(r.name)).join('、'), true] : null,
      ],
      files: info.files,
      filesNote: info.parents.length > 1 ? '與第一個父提交比較' : '',
      openFile: (f) => openDiff({ kind: 'commit', hash: info.hash, parent: info.parents[0] || '', path: f.path, orig: f.orig, status: f.status, label: f.label, title: `${basename(f.path)}（${info.hash.slice(0, 7)}）` }),
      actions: [['複製編號', () => copyText(info.hash)]],
      keepHash: hash,
    });
  }

  showDetail({ title, message, rows = [], files = [], filesNote = '', openFile, actions = [], keepHash = '' }) {
    if (!keepHash) { this.detailHash = ''; this.detailKeep = true; this.sel = -1; this.markSel(); }
    this.files = files;
    this.openFile = openFile;
    this.detailActs = actions.map((a) => a[1]);
    const tr = rows.filter(Boolean).map(([k, v, html]) => `<tr><td>${esc(k)}</td><td>${html ? v : esc(v)}</td></tr>`).join('');
    const fl = files.map((f, i) => `<div class="row" data-fi="${i}" title="${esc(`${f.orig ? `${f.orig} → ` : ''}${f.path}・${f.label}`)}"><span class="nm g-${esc(f.status)}${f.status === 'D' ? ' del' : ''}">${esc(basename(f.path))}</span><span class="dir">${esc(dirname(f.path))}</span><span class="gs g-${esc(f.status)}">${esc(f.status)}</span></div>`).join('');
    this.detail.innerHTML = `<div class="dtop"><span class="t" title="${esc(title)}">${esc(title)}</span><span class="sp"></span>${actions.map((a, i) => `<button class="secondary sm" data-dact="${i}">${esc(a[0])}</button>`).join('')}<button class="ib sm" data-dact="close" title="關閉（Esc）">✕</button></div>`
      + `<div class="dbody2"><div class="info"><pre class="m">${esc(message)}</pre><table>${tr}</table></div>`
      + `<div class="files"><div class="fh">${files.length} 個檔案${filesNote ? `・${esc(filesNote)}` : ''}</div>${fl || '<div class="empty-msg">沒有檔案變更</div>'}</div></div>`;
    this.detail.hidden = false;
    $('.dsplit', this.el).hidden = false;
  }

  closeDetail() {
    this.detail.hidden = true;
    $('.dsplit', this.el).hidden = true;
    this.detailHash = '';
    this.detailKeep = false;
  }

  onShow() { if (!st.log && st.rid) loadLog().catch(fail); }
}

function commitMenu(c) {
  const s = st.status;
  const cur = s.branch;
  const items = [
    ['複製提交編號', () => copyText(c.hash)],
    ['複製短編號', () => copyText(c.hash.slice(0, 7))],
    ['複製訊息', () => copyText(c.subject)],
    '-',
    ['與工作目錄比較', () => compareWorkingFlow(c)],
    st.cmpBase && st.cmpBase.hash !== c.hash ? [`與 ${st.cmpBase.label} 比較`, () => compareRangeFlow(st.cmpBase, { hash: c.hash, label: c.hash.slice(0, 7) })] : null,
    ['設為比較的起點', () => { st.cmpBase = { hash: c.hash, label: c.hash.slice(0, 7) }; notice(`已把 ${c.hash.slice(0, 7)} 設為比較的起點，再右鍵另一個提交選「與 ${c.hash.slice(0, 7)} 比較」`); }],
    ['存成 Patch…', async () => {
      const r = await api('savePatch', { hash: c.hash, subject: c.subject });
      if (r) notice(`已存成 ${r.filePath}`, 'ok');
    }],
    '-',
    ['從這裡建立分支…', () => newBranchFlow(c.hash, c.hash.slice(0, 7))],
    ['建立標籤…', () => createTagFlow(c.hash)],
  ];
  const locals = c.refs.filter((r) => r.type === 'local' && !r.head);
  const remotes = c.refs.filter((r) => r.type === 'remote');
  if (locals.length || remotes.length) items.push('-');
  for (const r of locals) items.push([`切換到 ${r.name}`, () => checkoutFlow({ branch: r.name }, r.name)], [`合併 ${r.name} 到 ${cur || 'HEAD'}`, () => mergeFlow(r.name)]);
  for (const r of remotes) items.push([`切換到 ${r.name}（建立本機分支）`, () => checkoutFlow({ remote: r.name }, r.name)], [`合併 ${r.name} 到 ${cur || 'HEAD'}`, () => mergeFlow(r.name)]);
  items.push('-', ['切換到這個提交（分離的 HEAD）', async () => {
    if (!await confirmBox(`切換到 ${c.hash.slice(0, 7)}？`, '切換', { detail: '會進入「分離的 HEAD」：可以查看當時的檔案，但新的提交不屬於任何分支。要回來時切換到原本的分支即可。' })) return;
    await checkoutFlow({ commit: c.hash }, c.hash.slice(0, 7));
  }]);
  if (!s.state && s.head && c.hash !== s.head.hash) {
    items.push(['揀選到目前分支（cherry-pick）', async () => {
      if (!await confirmBox(`把 ${c.hash.slice(0, 7)}「${c.subject}」複製一份到 ${cur || 'HEAD'}？`, '揀選')) return;
      const r = await withStash('揀選', () => api('cherryPick', { hash: c.hash }));
      if (r && r.conflict) { await onConflict(r); return; }
      if (r) notice('已揀選提交', 'ok');
      await refreshAll();
    }, { disabled: c.parents.length > 1 }]);
  }
  if (!s.state) {
    items.push(['還原這個提交（revert）', async () => {
      if (!await confirmBox(`建立一個新提交，抵銷 ${c.hash.slice(0, 7)}「${c.subject}」的變更？`, '還原', { detail: '原本的提交仍保留在歷史中，適合用在已經推送出去的提交。' })) return;
      const r = await withStash('還原', () => api('revert', { hash: c.hash }));
      if (r && r.conflict) { await onConflict(r); return; }
      if (r) notice('已建立還原提交', 'ok');
      await refreshAll();
    }, { disabled: c.parents.length > 1 }]);
  }
  if (!s.state) items.push(['修改提交訊息…', () => rewordFlow(c), { disabled: c.parents.length !== 1 && !(s.head && s.head.hash === c.hash) }]);
  if (cur && !s.state && s.head && c.hash !== s.head.hash) {
    items.push('-',
      [`把 ${cur} 重定基底到這裡（rebase）…`, () => rebaseOntoFlow(c.hash, c.hash.slice(0, 7))],
      [`互動式重定基底 ${cur} 到這裡…`, () => interactiveRebaseFlow(c)]);
    items.push('-', { label: `把 ${cur} 重設到這個提交` },
      ['　保留變更並暫存（soft）', () => resetFlow(c, 'soft')],
      ['　保留變更、不暫存（mixed）', () => resetFlow(c, 'mixed')],
      ['　捨棄所有變更（hard）…', () => resetFlow(c, 'hard'), { danger: true }]);
  }
  return items;
}

/** 提交與目前工作目錄的差異（Fork 的 Compare to Local Changes） */
async function compareWorkingFlow(c) {
  const files = await api('compare:files', { hash: c.hash });
  const g = graphTab();
  activate(g.id);
  const short = c.hash.slice(0, 7);
  g.view.showDetail({
    title: `${short} ↔ 工作目錄`,
    message: `${c.subject}\n\n比較這個提交與目前工作目錄中的檔案（包含還沒提交的變更，不含未追蹤的檔案）。`,
    rows: [['提交', `<span class="mono">${esc(c.hash)}</span>`, true]],
    files,
    openFile: (f) => openDiff({ kind: 'cmp', hash: c.hash, path: f.path, orig: f.orig, status: f.status, label: f.label, title: `${basename(f.path)}（${short} ↔ 工作目錄）` }),
  });
}

async function resetFlow(c, mode) {
  const cur = st.status.branch;
  const detail = mode === 'hard'
    ? '之後的提交與所有未提交的變更都會被捨棄，檔案會變回這個提交的內容。已推送的提交被重設後，需要強制推送。'
    : '之後的提交會從分支上移除，但那些變更會保留在工作目錄中，可以重新整理後再提交。';
  if (!await confirmBox(`把 ${cur} 重設到 ${c.hash.slice(0, 7)}「${c.subject}」？`, mode === 'hard' ? '捨棄並重設' : '重設', { type: 'warning', detail })) return;
  await api('reset', { hash: c.hash, mode });
  notice(`已把 ${cur} 重設到 ${c.hash.slice(0, 7)}`, 'ok');
  await refreshAll();
}

/* ───────────── 重定基底 ───────────── */

/** 把目前分支重定基底到 onto（分支或提交） */
async function rebaseOntoFlow(onto, label) {
  const cur = st.status.branch;
  if (!cur) { notice('目前不在任何分支上，無法重定基底', 'err'); return; }
  if (!await confirmBox(`把 ${cur} 重定基底到 ${label || onto}？`, '重定基底', { detail: `${cur} 上自己的提交會依序重新套用在 ${label || onto} 之後，歷史會變成一直線。已經推送過的提交重定基底後需要強制推送。有衝突時會停下來讓你逐一解決，也可以中止。` })) return;
  const r = await withStash('重定基底', () => api('rebase', { onto }));
  if (r && r.conflict) { await onConflict(r); return; }
  if (r) notice(`已把 ${cur} 重定基底到 ${label || onto}`, 'ok');
  await refreshAll();
}

/** 修改提交訊息（Fork 的 Edit Commit Message） */
async function rewordFlow(c) {
  const info = await api('commit:info', { hash: c.hash });
  const isHead = st.status.head && st.status.head.hash === c.hash;
  const v = await form({
    title: `修改提交訊息（${c.hash.slice(0, 7)}）`,
    desc: isHead ? '只改訊息，不會把已暫存的變更加進去。' : '會用互動式重定基底改寫這個提交之後的歷史（提交編號都會改變）。已經推送過的提交改寫後需要強制推送。',
    ok: '修改',
    fields: [{ name: 'message', label: '提交訊息', type: 'textarea', rows: 6, value: info.message }],
    validate: (x) => (!x.message.trim() ? '訊息不能是空的' : ''),
  });
  if (!v || v.message.trim() === info.message.trim()) return;
  const run = () => api('reword', { hash: c.hash, message: v.message });
  const r = isHead ? await run() : await withStash('修改提交訊息', run);
  if (r && r.conflict) { await onConflict(r); return; }
  if (r) notice('已修改提交訊息', 'ok');
  await refreshAll();
}

const RB_ACTIONS = [['pick', '保留（pick）'], ['reword', '改訊息（reword）'], ['squash', '併入上一個，合併訊息（squash）'], ['fixup', '併入上一個，捨棄訊息（fixup）'], ['drop', '移除（drop）']];
const rb = { base: null, steps: [], order: [] };

/** 互動式重定基底到這個提交：重新排序、合併、改訊息、移除這個提交之後的提交 */
async function interactiveRebaseFlow(c) {
  if (!st.status.branch) { notice('目前不在任何分支上，無法重定基底', 'err'); return; }
  const list = await api('rebase:list', { base: c.hash });
  if (!list.length) { notice('這個提交之後沒有其他提交'); return; }
  rb.base = c;
  rb.order = list.map((x) => x.hash);
  rb.steps = list.map((x) => ({ ...x, action: 'pick', edit: x.message, squashMsg: '' }));
  $('#rbTitle').textContent = `互動式重定基底：${st.status.branch} 到 ${c.hash.slice(0, 7)}`;
  $('#rbDesc').textContent = `${list.length} 個提交，由舊到新排列（上面的先套用）。用 ↑↓ 調整順序、選擇每個提交要做什麼。「併入上一個」會和上面那個提交合成一個。已推送過的提交改寫後需要強制推送。`;
  renderRb();
  $('#rbPanel').hidden = false;
}

function rbProblem() {
  const kept = rb.steps.filter((s) => s.action !== 'drop');
  if (!kept.length) return '至少要保留一個提交（全部移除請改用「重設」）';
  if (kept[0].action === 'squash' || kept[0].action === 'fixup') return '第一個保留的提交不能併入上一個提交';
  if (rb.steps.some((s) => s.action === 'reword' && !s.edit.trim())) return '改訊息的提交，訊息不能是空的';
  return '';
}

function renderRb() {
  const n = rb.steps.length;
  $('#rbList').innerHTML = rb.steps.map((s, i) => {
    const sel = `<select data-i="${i}">${RB_ACTIONS.map(([v, l]) => `<option value="${v}"${v === s.action ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const cls = s.action === 'drop' ? ' drop' : s.action === 'squash' || s.action === 'fixup' ? ' fold' : '';
    let msg = '';
    if (s.action === 'reword') msg = `<div class="rbmsg"><textarea data-msg="${i}" spellcheck="false">${esc(s.edit)}</textarea></div>`;
    if (s.action === 'squash') msg = `<div class="rbmsg"><textarea data-sq="${i}" spellcheck="false" placeholder="合併後的訊息（空白時把兩個提交的訊息接在一起）">${esc(s.squashMsg)}</textarea></div>`;
    return `<div class="rbrow${cls}"><button class="ib sm" data-mv="${i}:-1" title="往上"${i ? '' : ' disabled'}>↑</button><button class="ib sm" data-mv="${i}:1" title="往下"${i < n - 1 ? '' : ' disabled'}>↓</button>`
      + `${sel}<span class="sha">${esc(s.short)}</span><span class="subj" title="${esc(s.message)}">${esc(s.subject)}</span></div>${msg}`;
  }).join('');
  $('#rbHint').textContent = rbProblem();
}

function initRebase() {
  const box = $('#rbPanel');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) { if (e.target === box) box.hidden = true; return; }
    if (b.dataset.mv) {
      const [i, d] = b.dataset.mv.split(':').map(Number);
      const j = i + d;
      if (j < 0 || j >= rb.steps.length) return;
      [rb.steps[i], rb.steps[j]] = [rb.steps[j], rb.steps[i]];
      renderRb();
      return;
    }
    if (b.dataset.rb === 'close') { box.hidden = true; return; }
    if (b.dataset.rb === 'start') rbStart().catch(fail);
  });
  box.addEventListener('change', (e) => {
    const i = e.target.dataset.i;
    if (i === undefined) return;
    rb.steps[Number(i)].action = e.target.value;
    renderRb();
  });
  box.addEventListener('input', (e) => {
    if (e.target.dataset.msg !== undefined) rb.steps[Number(e.target.dataset.msg)].edit = e.target.value;
    if (e.target.dataset.sq !== undefined) rb.steps[Number(e.target.dataset.sq)].squashMsg = e.target.value;
    $('#rbHint').textContent = rbProblem();
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); box.hidden = true; } });
}

async function rbStart() {
  const p = rbProblem();
  if (p) { $('#rbHint').textContent = p; return; }
  const steps = rb.steps.map((s) => ({ hash: s.hash, action: s.action, message: s.action === 'reword' ? s.edit : s.action === 'squash' ? s.squashMsg : '' }));
  const changed = steps.some((s, i) => s.action !== 'pick' || s.hash !== rb.order[i]);
  $('#rbPanel').hidden = true;
  if (!changed) { notice('沒有變更，歷史保持不變'); return; }
  const r = await withStash('重定基底', () => api('rebase:interactive', { base: rb.base.hash, steps }));
  if (r && r.conflict) { await onConflict(r); return; }
  if (r) notice('互動式重定基底完成', 'ok');
  await refreshAll();
}

/* ───────────── 差異比對 ───────────── */

class DiffView {
  constructor(tab) {
    this.tab = tab;
    this.expanded = new Set();
    this.selDel = new Set(); // 選取的刪除行（左側行索引）
    this.selAdd = new Set(); // 選取的新增行（右側行索引）
    this.el = document.createElement('div');
    this.el.className = 'view diff';
    this.el.innerHTML = '<div class="dhead"></div><div class="dsel" hidden></div><div class="dlabels"><div></div><div></div></div><div class="dbody"></div>';
    this.head = $('.dhead', this.el);
    this.selBar = $('.dsel', this.el);
    this.body = $('.dbody', this.el);
    this.body.tabIndex = 0;
    this.body.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (this.selDel.size || this.selAdd.size)) { e.stopPropagation(); this.clearSel(); } });
    this.body.addEventListener('click', (e) => {
      const f = e.target.closest('.fold');
      if (f) { this.expanded.add(Number(f.dataset.start)); this.renderBody(); return; }
      const h = e.target.closest('[data-hact]');
      if (h) { const blk = this.blocks[Number(h.closest('.hunk').dataset.blk)]; if (blk) this.partialAct(h.dataset.hact, { del: blk.del, add: blk.add }).catch(fail); return; }
      // 點內容（沒有選取文字時）選取那一行
      const cell = e.target.closest('.c[data-la], .c[data-lb]');
      if (cell && this.pickable && window.getSelection().isCollapsed) {
        if (e.shiftKey && this.lastPick) this.pickRange(this.lastPick, cell);
        else this.toggle(cell, !this.isPicked(cell));
        this.lastPick = cell;
        this.updateSel();
      }
    });
    // 在行號上按住拖曳可以連續選取多行；Shift 點選選取一段範圍
    this.body.addEventListener('mousedown', (e) => {
      const cell = e.target.closest('.n[data-la], .n[data-lb], .s[data-la], .s[data-lb]');
      if (!cell || !this.pickable || e.button !== 0) return;
      e.preventDefault();
      if (e.shiftKey && this.lastPick) { this.pickRange(this.lastPick, cell); this.updateSel(); return; }
      const on = !this.isPicked(cell);
      this.toggle(cell, on);
      this.lastPick = cell;
      this.updateSel();
      const over = (ev) => {
        const c = ev.target.closest && ev.target.closest('[data-la], [data-lb]');
        if (c && this.body.contains(c)) { this.toggle(c, on); this.updateSel(); }
      };
      const up = () => { this.body.removeEventListener('mouseover', over); removeEventListener('mouseup', up); };
      this.body.addEventListener('mouseover', over);
      addEventListener('mouseup', up);
    });
    this.selBar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.sact === 'clear') { this.clearSel(); return; }
      this.partialAct(b.dataset.sact, { del: [...this.selDel], add: [...this.selAdd] }).catch(fail);
    });
    this.head.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) { this.expanded.clear(); st.diffMode = b.dataset.mode; store.set('diffMode', st.diffMode); this.render(); return; }
      if (b.dataset.nav) { this.nav(Number(b.dataset.nav)); return; }
      if (b.dataset.ws !== undefined) { st.diffWs = !st.diffWs; store.set('diffWs', st.diffWs); this.recompute(); this.render(); return; }
      if (b.dataset.wrap !== undefined) { st.diffWrap = !st.diffWrap; store.set('diffWrap', st.diffWrap); this.render(); return; }
      const src = this.tab.src;
      const act = b.dataset.act;
      if (act === 'reload') { this.load(); return; }
      if (act === 'history') { openHistory(src.path); return; }
      if (act === 'blame') { openBlame(src.path, src.kind === 'commit' ? src.hash : ''); return; }
      if (act === 'open') { api('openFile', { path: src.path }).catch(fail); return; }
      onChangeAction(act, src.area, src.path).then(() => this.afterAction()).catch(fail);
    });
  }

  /** 是否可以逐行操作：工作區的檔案、文字、沒有忽略空白 */
  get pickable() {
    const src = this.tab.src;
    const d = this.data;
    if (!d || src.kind !== 'work' || !['unstaged', 'untracked', 'staged'].includes(src.area)) return false;
    if (src.area === 'staged' && src.orig) return false;
    const bad = (x) => x.binary || x.tooLarge || x.readOnly;
    return !bad(d.left) && !bad(d.right) && !st.diffWs;
  }

  isPicked(cell) {
    return cell.dataset.la !== undefined ? this.selDel.has(Number(cell.dataset.la)) : this.selAdd.has(Number(cell.dataset.lb));
  }

  toggle(cell, on) {
    const set = cell.dataset.la !== undefined ? this.selDel : this.selAdd;
    const n = Number(cell.dataset.la !== undefined ? cell.dataset.la : cell.dataset.lb);
    if (on) set.add(n); else set.delete(n);
  }

  /** 選取兩個儲存格之間（依畫面順序）所有可選取的行 */
  pickRange(from, to) {
    const cells = $$('.n[data-la], .n[data-lb]', this.body);
    const idx = (c) => cells.findIndex((x) => x.closest('.dr') === c.closest('.dr'));
    let i = idx(from), j = idx(to);
    if (i < 0 || j < 0) { this.toggle(to, true); return; }
    if (i > j) [i, j] = [j, i];
    // 同一列的兩側都算在範圍內
    while (j + 1 < cells.length && cells[j + 1].closest('.dr') === cells[j].closest('.dr')) j++;
    while (i > 0 && cells[i - 1].closest('.dr') === cells[i].closest('.dr')) i--;
    for (const c of cells.slice(i, j + 1)) this.toggle(c, true);
  }

  clearSel() {
    this.selDel.clear();
    this.selAdd.clear();
    this.lastPick = null;
    this.updateSel();
  }

  /** 更新選取的標示與上方的動作列 */
  updateSel() {
    for (const c of $$('[data-la], [data-lb]', this.body)) c.classList.toggle('pick', this.isPicked(c));
    const n = this.selDel.size + this.selAdd.size;
    const src = this.tab.src;
    if (!this.pickable) {
      const why = this.data && src.kind === 'work' && st.diffWs ? '忽略空白時不能逐行暫存' : '';
      this.selBar.hidden = !why;
      this.selBar.innerHTML = why ? `<span class="hint">${esc(why)}</span>` : '';
      return;
    }
    if (!n) {
      this.selBar.hidden = false;
      const verb = src.area === 'staged' ? '取消暫存' : '暫存或捨棄';
      this.selBar.innerHTML = `<span class="hint">點行號選取要${verb}的行（拖曳選取多行、Shift 點選選取一段），或用每段變更上方的按鈕整段處理。</span>`;
      return;
    }
    const lines = `${n} 行（刪除 ${this.selDel.size}、新增 ${this.selAdd.size}）`;
    const acts = src.area === 'staged'
      ? '<button class="sm" data-sact="unstage">− 取消暫存選取的行</button>'
      : '<button class="sm" data-sact="stage">＋ 暫存選取的行</button><button class="secondary sm" data-sact="discard">↺ 捨棄選取的行</button>';
    this.selBar.hidden = false;
    this.selBar.innerHTML = `<span class="t">已選取 ${esc(lines)}</span>${acts}<span class="sp"></span><button class="ib sm" data-sact="clear" title="清除選取（Esc）">✕</button>`;
  }

  /** 暫存、取消暫存或捨棄一部分的行 */
  async partialAct(action, { del, add }) {
    const src = this.tab.src;
    const d = this.data;
    if (!d || (!del.length && !add.length)) return;
    if (action === 'discard') {
      const n = del.length + add.length;
      if (!await confirmBox(`捨棄選取的 ${n} 行變更？`, '捨棄', { type: 'warning', detail: '工作目錄中這幾行會還原成暫存區的內容，目前的修改無法復原。' })) return;
    }
    await api('partial', { area: src.area, action, path: src.path, del, add, check: `${C.textHash(d.left.text)}:${C.textHash(d.right.text)}` });
    this.selDel.clear();
    this.selAdd.clear();
    this.lastPick = null;
    notice(action === 'stage' ? '已暫存選取的變更' : action === 'unstage' ? '已取消暫存選取的變更' : '已捨棄選取的變更', 'ok');
    await refresh();
    await this.afterAction();
  }

  async afterAction() {
    // 動作後檔案可能換到另一組（例如暫存後從「變更」到「已暫存」）；還在原本那組時留在原地
    const src = this.tab.src;
    const s = st.status;
    const order = [src.area, 'unstaged', 'staged', 'untracked'];
    const next = order.map((a) => [a, entryOf(a, src.path)]).find(([, e]) => e);
    if (!next) { closeTab(this.tab.id); return; }
    const [area, e] = next;
    if (area !== src.area) { this.expanded.clear(); this.clearSel(); }
    this.tab.src = { kind: 'work', area, ...e };
    this.tab.title = `${basename(e.path)}${area === 'staged' ? '（已暫存）' : ''}`;
    this.tab.key = `w:${area}:${e.path}`;
    renderTabs();
    if (s) this.load();
  }

  recompute() {
    const norm = st.diffWs ? (l) => l.map(C.normWs) : (l) => l;
    this.ops = C.diffLines(norm(this.a), norm(this.b));
    this.stats = C.diffStats(this.ops);
  }

  async load() {
    const src = this.tab.src;
    const same = this.data && this.data.path === src.path && this.loadedKey === `${src.kind}:${src.area || src.hash}:${src.path}`;
    const keep = same ? this.body.scrollTop : 0;
    if (!same) { this.body.innerHTML = '<div class="dnote">讀取中…</div>'; this.selDel.clear(); this.selAdd.clear(); this.lastPick = null; }
    try {
      let d;
      if (src.kind === 'work') {
        d = await api('diff', { area: src.area, path: src.path, orig: src.orig });
      } else if (src.kind === 'cmp') {
        d = await api('compare:diff', { hash: src.hash, path: src.path, orig: src.orig });
      } else {
        d = await api('commit:diff', { hash: src.hash, parent: src.parent || undefined, path: src.path, orig: src.orig });
        // 儲藏中未追蹤的檔案放在第三個父提交
        if (!d.right.exists && src.untrackedHash) d = await api('commit:diff', { hash: src.untrackedHash, path: src.path });
      }
      if (this.tab.src !== src) return;
      // 內容變了，選取的行號就不再可靠
      if (same && this.data && (this.data.left.text !== d.left.text || this.data.right.text !== d.right.text)) { this.selDel.clear(); this.selAdd.clear(); this.lastPick = null; }
      this.data = d;
      this.loadedKey = `${src.kind}:${src.area || src.hash}:${src.path}`;
      this.a = C.toLines(d.left.text);
      this.b = C.toLines(d.right.text);
      this.recompute();
      this.render();
      if (same) this.body.scrollTop = keep;
    } catch (err) {
      this.data = null;
      this.head.innerHTML = '<span class="sp"></span><button class="ib sm" data-act="reload" title="重新整理">⟳</button>';
      this.selBar.hidden = true;
      this.body.innerHTML = `<div class="dnote">無法比對：${esc(errInfo(err).message)}</div>`;
    }
  }

  render() {
    const src = this.tab.src;
    const d = this.data;
    if (!d) return;
    const s = this.stats;
    const where = src.kind === 'work' ? (GROUPS.find((g) => g[0] === src.area) || [])[1] : src.kind === 'cmp' ? `${src.hash.slice(0, 7)} ↔ 工作目錄` : `提交 ${src.hash.slice(0, 7)}`;
    let acts = '';
    if (src.kind === 'work') {
      if (src.area === 'unstaged') acts = '<button class="secondary sm" data-act="discard">↺ 捨棄檔案</button><button class="sm" data-act="stage">＋ 暫存檔案</button>';
      else if (src.area === 'staged') acts = '<button class="secondary sm" data-act="unstage">− 取消暫存檔案</button>';
      else if (src.area === 'untracked') acts = '<button class="secondary sm" data-act="discard">🗑 刪除</button><button class="sm" data-act="stage">＋ 暫存檔案</button>';
    }
    if ((src.kind === 'work' || src.kind === 'cmp') && src.status !== 'D') acts += '<button class="secondary sm" data-act="open">開啟檔案</button>';
    const tracked = !(src.kind === 'work' && src.area === 'untracked') && !(src.kind === 'work' && src.area === 'staged' && src.status === 'A');
    const ft = tracked && !d.left.binary && !d.right.binary && !(src.status === 'D' && src.kind !== 'commit');
    if (tracked && this.tab.kind !== undefined) acts += '<button class="ib sm" data-act="history" title="檔案歷史">🕘</button>';
    if (ft) acts += '<button class="ib sm" data-act="blame" title="逐行追溯（blame）：每一行最後是哪個提交改的">👤</button>';
    this.head.innerHTML = `<span class="p" title="${esc(src.path)}">${esc(src.path)}</span><span class="st g-${esc(src.status)}">${esc(where || '')}・${esc(src.label || '')}</span>`
      + `<span class="add">+${s.added}</span><span class="del">−${s.removed}</span><span class="sp"></span>`
      + `<div class="seg"><button data-mode="sbs" class="${st.diffMode === 'sbs' ? 'on' : ''}">並排</button><button data-mode="uni" class="${st.diffMode === 'uni' ? 'on' : ''}">行內</button></div>`
      + `<button class="ib sm${st.diffWrap ? ' on' : ''}" data-wrap title="${st.diffWrap ? '目前自動換行（點選改成不換行、左右捲動）' : '目前不換行（點選改成自動換行）'}">↵</button>`
      + `<button class="ib sm${st.diffWs ? ' on' : ''}" data-ws title="${st.diffWs ? '目前忽略空白的差異（點選改回顯示）' : '忽略空白的差異'}">␣</button>`
      + '<button class="ib sm" data-nav="-1" title="上一個變更">↑</button><button class="ib sm" data-nav="1" title="下一個變更">↓</button>'
      // 內嵌在檔案歷史時，重新整理由歷史分頁負責
      + `${acts}${this.tab.kind !== undefined ? '<button class="ib sm" data-act="reload" title="重新整理">⟳</button>' : ''}`;
    const labels = $('.dlabels', this.el);
    labels.hidden = st.diffMode !== 'sbs';
    labels.children[0].textContent = `${d.left.label}${d.left.note ? `（${d.left.note}）` : ''}`;
    labels.children[1].textContent = `${d.right.label}${d.right.note ? `（${d.right.note}）` : ''}`;
    this.renderBody();
  }

  renderBody() {
    const d = this.data;
    if (!d) return;
    this.blocks = [];
    const done = (html) => { this.body.innerHTML = html; this.updateSel(); };
    if (d.left.image || d.right.image) {
      const fig = (x) => `<figure><figcaption>${esc(x.label)}${x.size ? `・${(x.size / 1024).toFixed(1)} KB` : ''}</figcaption>${x.image ? `<img src="${x.image}" alt="">` : `<div class="dnote">${x.exists ? esc(x.note || '無法顯示') : '（不存在）'}</div>`}</figure>`;
      this.body.className = 'dbody';
      return done(`<div class="imgdiff">${fig(d.left)}${fig(d.right)}</div>`);
    }
    if (d.left.binary || d.right.binary) return done('<div class="dnote">二進位檔案，無法顯示差異。</div>');
    if (d.left.tooLarge || d.right.tooLarge) return done(`<div class="dnote">${esc(d.left.note || d.right.note)}</div>`);
    if (!this.ops.length) return done('<div class="dnote">檔案是空的。</div>');
    if (!this.stats.added && !this.stats.removed) {
      return done(`<div class="dnote">內容相同${st.diffWs ? '（忽略空白）' : this.tab.src.status === 'R' ? '（只有重新命名）' : '（可能只有權限或換行字元不同）'}。</div>`);
    }
    const sbs = st.diffMode === 'sbs';
    const pick = this.pickable;
    const area = this.tab.src.area;
    this.body.className = `dbody ${sbs ? 'sbs' : 'uni'}${pick ? ' pickable' : ''}${st.diffWrap ? '' : ' nowrap'}`;
    const digits = String(Math.max(this.a.length, this.b.length)).length;
    this.body.style.setProperty('--lnw', `calc(${digits}ch + 16px)`);
    if (!st.diffWrap) {
      // 不換行時以最長的一行決定列寬，並排的兩側才會對齊（全形字約佔兩格、tab 四格）
      const w = (l) => { let n = 0; for (const ch of l) n += ch === '\t' ? 4 : /[\u1100-\uffef]/.test(ch) ? 2 : 1; return n; };
      let max = 0;
      for (const l of this.a) max = Math.max(max, w(l));
      for (const l of this.b) max = Math.max(max, w(l));
      this.body.style.setProperty('--roww', sbs ? `calc(2 * (${max}ch + 16px + var(--lnw)))` : `calc(${max}ch + 16px + 2 * var(--lnw) + 18px)`);
    }
    const rows = C.fold(sbs ? C.sideBySide(this.ops) : C.unified(this.ops), 3, this.expanded);
    const A = (i) => esc(this.a[i] || '');
    const B = (i) => esc(this.b[i] || '');
    const la = (i) => (pick ? ` data-la="${i}"` : '');
    const lb = (i) => (pick ? ` data-lb="${i}"` : '');
    const hunkActs = area === 'staged'
      ? '<button class="secondary" data-hact="unstage">− 取消暫存這段</button>'
      : '<button class="secondary" data-hact="stage">＋ 暫存這段</button><button class="secondary" data-hact="discard">↺ 捨棄這段</button>';
    const out = [];
    let prev = 'eq';
    for (const r of rows) {
      if (r.kind === 'fold') { out.push(`<div class="dr fold" data-start="${r.start}"><span>⋯ 展開 ${r.count} 行未變更的內容</span></div>`); prev = 'eq'; continue; }
      const first = r.kind !== 'eq' && prev === 'eq';
      prev = r.kind;
      if (first) {
        this.blocks.push({ del: [], add: [] });
        if (pick) out.push(`<div class="dr hunk" data-blk="${this.blocks.length - 1}"><span>第 ${this.blocks.length} 段變更${hunkActs}</span></div>`);
      }
      if (r.kind !== 'eq') {
        const blk = this.blocks[this.blocks.length - 1];
        if (r.a !== null) blk.del.push(r.a);
        if (r.b !== null) blk.add.push(r.b);
      }
      const start = first ? ' data-chg="1"' : '';
      if (sbs) {
        const lk = r.kind === 'eq' ? '' : r.a === null ? 'none' : 'del';
        const rk = r.kind === 'eq' ? '' : r.b === null ? 'none' : 'add';
        const L = lk === 'del' ? la(r.a) : '';
        const R = rk === 'add' ? lb(r.b) : '';
        out.push(`<div class="dr"${start}><span class="n ${lk}"${L}>${r.a !== null ? r.a + 1 : ''}</span><span class="c ${lk}"${L}>${r.a !== null ? A(r.a) : ''}</span>`
          + `<span class="n ${rk}"${R}>${r.b !== null ? r.b + 1 : ''}</span><span class="c ${rk}"${R}>${r.b !== null ? B(r.b) : ''}</span></div>`);
      } else {
        const k = r.kind === 'eq' ? '' : r.kind;
        const at = k === 'del' ? la(r.a) : k === 'add' ? lb(r.b) : '';
        out.push(`<div class="dr"${start}><span class="n ${k}"${at}>${r.a !== null ? r.a + 1 : ''}</span><span class="n ${k}"${at}>${r.b !== null ? r.b + 1 : ''}</span>`
          + `<span class="s ${k}"${at}>${r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}</span><span class="c ${k}"${at}>${r.kind === 'del' ? A(r.a) : B(r.b)}</span></div>`);
      }
    }
    // 摺疊的段落不在畫面上，但仍屬於同一段變更：區塊以畫面為準即可（摺疊只發生在沒有變更的行）
    done(out.join(''));
  }

  nav(dir) {
    const chg = $$('.dr[data-chg]', this.body);
    if (!chg.length) return;
    const top = this.body.scrollTop;
    let i;
    if (dir > 0) { i = chg.findIndex((r) => r.offsetTop > top + 40); if (i < 0) i = 0; } else {
      i = -1;
      for (let k = chg.length - 1; k >= 0; k--) if (chg[k].offsetTop < top - 4) { i = k; break; }
      if (i < 0) i = chg.length - 1;
    }
    for (const r of $$('.dr.focus', this.body)) r.classList.remove('focus');
    chg[i].classList.add('focus');
    this.body.scrollTop = Math.max(0, chg[i].offsetTop - 60);
    notice(`第 ${i + 1} / ${chg.length} 處變更`);
  }

  onStatus() {
    // 工作區的檔案在外部改變時重新比對
    const src = this.tab.src;
    if (src.kind !== 'work' || this.el.hidden) return;
    const e = entryOf(src.area, src.path);
    if (!e) { this.afterAction(); return; }
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load(), 200);
  }
}

/** 開啟差異分頁：單擊以預覽分頁開啟（取代上一個預覽），pin 時固定 */
function openDiff(src, { pin = false } = {}) {
  const key = src.kind === 'work' ? `w:${src.area}:${src.path}` : `${src.kind}:${src.hash}:${src.path}`;
  const title = src.title || `${basename(src.path)}${src.kind === 'work' ? (src.area === 'staged' ? '（已暫存）' : '') : ''}`;
  let t = st.tabs.find((x) => x.kind === 'diff' && x.key === key);
  if (!t) {
    t = st.tabs.find((x) => x.kind === 'diff' && x.preview);
    if (t) {
      t.key = key;
      t.view.expanded.clear();
    } else {
      t = { kind: 'diff', key, preview: true };
      t.view = new DiffView(t);
      addTab(t);
    }
  }
  t.src = src;
  t.title = title;
  t.tip = src.path;
  if (pin) t.preview = false;
  activate(t.id);
  t.view.load();
  return t;
}

/* ───────────── 檔案歷史 ───────────── */

const STATUS_LABEL = { M: '修改', A: '新增', D: '刪除', R: '重新命名', C: '複製', T: '類型變更' };

class HistoryView {
  constructor(tab) {
    this.tab = tab;
    this.items = [];
    this.sel = -1;
    this.el = document.createElement('div');
    this.el.className = 'view hist';
    this.el.innerHTML = '<div class="ghead"><span class="t"></span><span class="sp"></span><button class="ib sm" data-h="blame" title="逐行追溯（blame）">👤</button><button class="ib sm" data-h="reload" title="重新整理">⟳</button></div>'
      + '<div class="hsplit"><div class="hlist" tabindex="0"></div><div class="hdiff"></div></div>';
    this.list = $('.hlist', this.el);
    this.inner = { src: null };
    this.diff = new DiffView(this.inner);
    $('.hdiff', this.el).append(this.diff.el);
    $('.ghead', this.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-h]');
      if (!b) return;
      if (b.dataset.h === 'reload') this.load().catch(fail);
      else openBlame(this.tab.path, this.items[this.sel] ? this.items[this.sel].hash : '');
    });
    this.list.addEventListener('click', (e) => { const r = e.target.closest('.hrow'); if (r) this.select(Number(r.dataset.i)); });
    this.list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      this.select(Math.max(0, Math.min(this.items.length - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1))));
    });
    this.list.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.hrow');
      if (!r) return;
      const h = this.items[Number(r.dataset.i)];
      this.select(Number(r.dataset.i));
      contextMenu(e, [
        ['在線圖中顯示', () => showCommitInGraph(h.hash)],
        ['這個版本的逐行追溯', () => openBlame(h.path, h.hash)],
        ['與工作目錄比較', () => openDiff({ kind: 'cmp', hash: h.hash, path: this.tab.path, orig: h.path !== this.tab.path ? h.path : undefined, status: 'M', label: '比較', title: `${basename(this.tab.path)}（${h.hash.slice(0, 7)} ↔ 工作目錄）` }, { pin: true })],
        '-',
        ['複製提交編號', () => copyText(h.hash)],
        ['複製訊息', () => copyText(h.subject)],
      ]);
    });
  }

  async load() {
    this.list.innerHTML = '<div class="dnote">讀取中…</div>';
    this.items = await api('file:history', { path: this.tab.path });
    $('.t', this.el).textContent = `${this.tab.path} 的歷史・${this.items.length} 個提交`;
    if (!this.items.length) { this.list.innerHTML = '<div class="dnote">這個檔案還沒有提交過。</div>'; return; }
    this.list.innerHTML = this.items.map((h, i) => `<div class="hrow" data-i="${i}" title="${esc(`${h.hash}\n${h.author}・${C.formatDate(h.time)}${h.orig ? `\n${h.orig} → ${h.path}` : h.path !== this.tab.path ? `\n當時的路徑：${h.path}` : ''}`)}">`
      + `<div class="s1"><span class="subj">${esc(h.subject)}</span><span class="gs g-${esc(h.status)}">${esc(h.status)}</span></div>`
      + `<div class="s2"><span class="sha">${esc(h.hash.slice(0, 7))}</span><span>${esc(h.author)}</span><span class="sp"></span><span>${esc(C.ago(h.time))}</span></div></div>`).join('');
    this.select(Math.max(0, Math.min(this.sel, this.items.length - 1)));
  }

  select(i) {
    const h = this.items[i];
    if (!h) return;
    this.sel = i;
    for (const r of $$('.hrow', this.list)) r.classList.toggle('sel', Number(r.dataset.i) === i);
    const row = $(`.hrow[data-i="${i}"]`, this.list);
    if (row) row.scrollIntoView({ block: 'nearest' });
    this.inner.src = { kind: 'commit', hash: h.hash, parent: h.parents[0] || '', path: h.path, orig: h.orig, status: h.status, label: STATUS_LABEL[h.status] || h.status };
    this.diff.load();
  }
}

function openHistory(p) {
  const key = `h:${p}`;
  let t = st.tabs.find((x) => x.kind === 'hist' && x.key === key);
  if (!t) {
    t = { kind: 'hist', key, path: p, title: `🕘 ${basename(p)}`, tip: `${p} 的歷史` };
    t.view = new HistoryView(t);
    addTab(t);
    t.view.load().catch(fail);
  } else activate(t.id);
}

/** 在線圖中選取並顯示提交（不在目前載入的範圍時只顯示內容） */
function showCommitInGraph(hash) {
  const g = graphTab();
  activate(g.id);
  const i = st.log ? st.log.commits.findIndex((c) => c.hash === hash) : -1;
  if (i >= 0) g.view.select(i, { scroll: true });
  else g.view.showCommit(hash).catch(fail);
}

/* ───────────── 逐行追溯（blame） ───────────── */

class BlameView {
  constructor(tab) {
    this.tab = tab;
    this.el = document.createElement('div');
    this.el.className = 'view blame';
    this.el.innerHTML = '<div class="ghead"><span class="t"></span><span class="sp"></span><button class="ib sm" data-b="hist" title="檔案歷史">🕘</button><button class="ib sm" data-b="reload" title="重新整理">⟳</button></div><div class="bbody"></div>';
    this.body = $('.bbody', this.el);
    $('.ghead', this.el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (!b) return;
      if (b.dataset.b === 'reload') this.load().catch(fail); else openHistory(this.tab.path);
    });
    this.body.addEventListener('click', (e) => {
      const g = e.target.closest('.bg[data-h]');
      if (!g) return;
      if (/^0+$/.test(g.dataset.h)) { notice('這幾行還沒有提交'); return; }
      showCommitInGraph(g.dataset.h);
    });
  }

  async load() {
    this.body.innerHTML = '<div class="dnote">讀取中…</div>';
    const r = await api('blame', { path: this.tab.path, rev: this.tab.rev || undefined });
    const n = r.lines.length;
    $('.t', this.el).textContent = `${r.path}${this.tab.rev ? `（${this.tab.rev.slice(0, 7)}）` : '（工作目錄）'}・${n} 行`;
    const order = [];
    for (const l of r.lines) if (!order.includes(l.hash)) order.push(l.hash);
    const digits = String(n).length;
    this.body.style.setProperty('--lnw', `calc(${digits}ch + 16px)`);
    let prev = null;
    let band = 0;
    this.body.innerHTML = r.lines.map((l, i) => {
      const c = r.commits[l.hash] || {};
      const first = l.hash !== prev;
      if (first) band ^= 1;
      prev = l.hash;
      const zero = /^0+$/.test(l.hash);
      const info = first ? (zero ? '<span class="who">尚未提交</span>' : `<span class="sha">${esc(l.hash.slice(0, 7))}</span><span class="who">${esc(c.author || '')}</span><span class="when">${esc(c.time ? C.ago(c.time) : '')}</span>`) : '';
      const tip = zero ? '尚未提交的變更' : `${l.hash.slice(0, 10)} ${c.summary || ''}\n${c.author || ''}・${c.time ? C.formatDate(c.time) : ''}\n點選在線圖中顯示`;
      return `<div class="bl b${band}${first ? ' first' : ''}"><span class="bg" data-h="${esc(l.hash)}" title="${esc(tip)}">${info}</span><span class="n">${i + 1}</span><span class="c">${esc(l.text)}</span></div>`;
    }).join('');
  }
}

function openBlame(p, rev = '') {
  const key = `b:${p}:${rev}`;
  let t = st.tabs.find((x) => x.kind === 'blame' && x.key === key);
  if (!t) {
    t = { kind: 'blame', key, path: p, rev, title: `👤 ${basename(p)}${rev ? `（${rev.slice(0, 7)}）` : ''}`, tip: `${p} 的逐行追溯` };
    t.view = new BlameView(t);
    addTab(t);
    t.view.load().catch((err) => { t.view.body.innerHTML = `<div class="dnote">無法逐行追溯：${esc(errInfo(err).message)}</div>`; });
  } else activate(t.id);
}

/* ───────────── 參照紀錄（reflog） ───────────── */

class ReflogView {
  constructor(tab) {
    this.tab = tab;
    this.items = [];
    this.el = document.createElement('div');
    this.el.className = 'view reflog';
    this.el.innerHTML = '<div class="ghead"><span class="t">參照紀錄（reflog）</span><span class="faint">HEAD 每一次移動的紀錄：被重設、重定基底或刪除分支而「不見」的提交，可以從這裡找回</span><span class="sp"></span><button class="ib sm" data-r="reload" title="重新整理">⟳</button></div><div class="rlist"></div>';
    this.list = $('.rlist', this.el);
    $('.ghead', this.el).addEventListener('click', (e) => { if (e.target.closest('[data-r="reload"]')) this.load().catch(fail); });
    this.list.addEventListener('click', (e) => {
      const r = e.target.closest('.rrow');
      if (!r) return;
      for (const x of $$('.rrow.sel', this.list)) x.classList.remove('sel');
      r.classList.add('sel');
    });
    this.list.addEventListener('dblclick', (e) => { const r = e.target.closest('.rrow'); if (r) showCommitInGraph(this.items[Number(r.dataset.i)].hash); });
    this.list.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.rrow');
      if (!r) return;
      const x = this.items[Number(r.dataset.i)];
      const c = { hash: x.hash, subject: x.subject, parents: [] };
      const cur = st.status && st.status.branch;
      contextMenu(e, [
        ['查看這個提交', () => showCommitInGraph(x.hash)],
        ['從這裡建立分支…', () => newBranchFlow(x.hash, x.hash.slice(0, 7))],
        ['切換到這個提交（分離的 HEAD）', () => checkoutFlow({ commit: x.hash }, x.hash.slice(0, 7))],
        ['與工作目錄比較', () => compareWorkingFlow(c)],
        '-',
        ['複製提交編號', () => copyText(x.hash)],
        cur ? '-' : null,
        cur ? { label: `把 ${cur} 重設到這裡` } : null,
        cur ? ['　保留變更（mixed）', () => resetFlow(c, 'mixed')] : null,
        cur ? ['　捨棄所有變更（hard）…', () => resetFlow(c, 'hard'), { danger: true }] : null,
      ]);
    });
  }

  async load() {
    this.list.innerHTML = '<div class="dnote">讀取中…</div>';
    this.items = await api('reflog');
    if (!this.items.length) { this.list.innerHTML = '<div class="dnote">沒有參照紀錄。</div>'; return; }
    this.list.innerHTML = this.items.map((x, i) => `<div class="rrow" data-i="${i}" title="${esc(`${x.hash}\n${x.subject}\n雙擊在線圖中查看，右鍵可以建立分支或重設`)}">`
      + `<span class="ref">${esc(x.ref)}</span><span class="sha">${esc(x.hash.slice(0, 7))}</span><span class="act">${esc(x.action)}</span><span class="when">${esc(C.ago(x.time))}</span></div>`).join('');
  }

  onShow() { this.load().catch(fail); }
}

function openReflog() {
  let t = st.tabs.find((x) => x.kind === 'reflog');
  if (t) { activate(t.id); return; }
  t = { kind: 'reflog', key: 'reflog', title: '↺ 參照紀錄', tip: 'HEAD 的參照紀錄（reflog）' };
  t.view = new ReflogView(t);
  addTab(t);
}

/* ───────────── 比較兩個提交或分支 ───────────── */

/** from → to 的差異（Fork 的 Compare）；from、to 為 { hash, label } */
async function compareRangeFlow(from, to) {
  const files = await api('compare:range', { from: from.hash, to: to.hash });
  const g = graphTab();
  activate(g.id);
  g.view.showDetail({
    title: `${from.label} ↔ ${to.label}`,
    message: `從 ${from.label} 到 ${to.label} 變更的檔案。`,
    rows: [['起點', `<span class="mono">${esc(from.hash)}</span>`, true], ['終點', `<span class="mono">${esc(to.hash)}</span>`, true]],
    files,
    openFile: (f) => openDiff({ kind: 'commit', hash: to.hash, parent: from.hash, path: f.path, orig: f.orig, status: f.status, label: f.label, title: `${basename(f.path)}（${from.label} ↔ ${to.label}）` }),
    actions: [['對調', () => compareRangeFlow(to, from)]],
  });
}

/* ───────────── 子模組、工作樹 ───────────── */

async function loadExtras() {
  const [subs, wts] = await Promise.all([api('submodules').catch(() => []), api('worktrees').catch(() => [])]);
  st.subs = subs;
  st.worktrees = wts;
}

async function submoduleUpdateFlow(p) {
  await api('submodule:update', { path: p });
  notice(p ? `已更新子模組 ${p}` : '已更新所有子模組', 'ok');
  await loadBranches();
  await refresh();
}

/** 開啟子模組或工作樹：加入儲存庫清單並切換過去 */
async function openRepoAt(dir, name) {
  const res = await td.invoke('addRepo', { root: dir, name });
  st.repos = res.repos;
  await selectRepo(res.repo.id);
}

async function addWorktreeFlow() {
  const b = await ensureBranches();
  const used = new Set((st.worktrees || []).map((w) => w.branch).filter(Boolean));
  const free = b.local.filter((x) => !used.has(x.name));
  const parent = dirname(repo().root.replace(/\\/g, '/'));
  const v = await form({
    title: '新增工作樹（worktree）',
    desc: '在另一個資料夾簽出另一個分支，兩邊可以同時修改，不必來回切換或儲藏。',
    ok: '新增',
    fields: [
      { name: 'mode', label: '分支', type: 'select', value: 'new', options: [['new', '建立新分支'], ...free.map((x) => [`b:${x.name}`, `使用既有的分支 ${x.name}`])] },
      { name: 'name', label: '新分支名稱（建立新分支時）', placeholder: '例如：feature/login' },
      { name: 'dir', label: '資料夾', value: parent ? `${parent}/${basename(repo().root)}-wt` : '', browse: true, help: '不存在時會自動建立；已經存在時必須是空的' },
      { name: 'open', label: '新增後開啟', type: 'checkbox', value: true },
    ],
    validate: (x) => (!x.dir.trim() ? '請選擇資料夾' : x.mode === 'new' && !x.name.trim() ? '請輸入新分支名稱' : ''),
    onInput: (name, x, set) => { if (name === 'name' && x.name.trim()) set('dir', `${parent}/${basename(repo().root)}-${x.name.trim().replace(/[\\/]/g, '-')}`); },
  });
  if (!v) return;
  const dir = await api('worktree:add', { dir: v.dir.trim(), ...(v.mode === 'new' ? { newBranch: v.name.trim() } : { branch: v.mode.slice(2) }) });
  notice(`已新增工作樹：${dir}`, 'ok');
  if (v.open) await openRepoAt(dir, basename(dir));
  else await loadBranches();
}

async function removeWorktreeFlow(w) {
  const c = await choose(`移除工作樹 ${w.path}？`, ['移除', '強制移除（捨棄裡面未提交的變更）', '取消'], { type: 'warning', detail: `會刪除這個資料夾；分支 ${w.branch || ''} 與它的提交會保留。有未提交的變更時一般移除會失敗。` });
  if (c === 2) return;
  await api('worktree:remove', { dir: w.path, force: c === 1 });
  notice('已移除工作樹', 'ok');
  await loadBranches();
}

/* ───────────── 衝突解決 ───────────── */

class ConflictView {
  constructor(tab) {
    this.tab = tab;
    this.choices = {};
    this.expanded = new Set();
    this.el = document.createElement('div');
    this.el.className = 'view conflict';
    this.el.innerHTML = '<div class="dhead"></div><div class="cbody"></div>';
    this.head = $('.dhead', this.el);
    this.body = $('.cbody', this.el);
    this.head.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b) this.action(b.dataset.act).catch(fail);
    });
    this.body.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fold]');
      if (f) { this.expanded.add(Number(f.dataset.fold)); this.renderBody(); return; }
      const b = e.target.closest('button[data-pick]');
      if (b) {
        const i = Number(b.closest('.cblk').dataset.i);
        const pick = b.dataset.pick;
        if (pick === 'undo') delete this.choices[i];
        else if (pick === 'edit') {
          const seg = this.conflicts[i];
          const cur = this.choices[i];
          this.choices[i] = { text: cur ? C.resolved(seg, cur, this.eol) : C.resolved(seg, 'both', this.eol) };
        } else this.choices[i] = pick;
        this.renderBody();
        this.renderHead();
        if (pick !== 'edit' && pick !== 'undo') this.jump(1, i);
        else if (pick === 'edit') { const ta = $(`.cblk[data-i="${i}"] textarea`, this.body); if (ta) ta.focus(); }
        return;
      }
      const a = e.target.closest('button[data-act]');
      if (a) this.action(a.dataset.act).catch(fail);
    });
    this.body.addEventListener('input', (e) => {
      const ta = e.target.closest('textarea[data-edit]');
      // textarea 一律用 \n，存回時換成檔案原本的換行字元
      if (ta) { this.choices[Number(ta.dataset.edit)] = { text: this.eol === '\r\n' ? ta.value.replace(/\r?\n/g, '\r\n') : ta.value }; this.renderHead(); }
    });
  }

  async load() {
    this.body.innerHTML = '<div class="dnote">讀取中…</div>';
    const info = await api('conflict:info', { path: this.tab.src.path });
    this.info = info;
    this.choices = {};
    this.expanded.clear();
    this.segs = null;
    this.conflicts = [];
    const w = info.working;
    // 只有雙方都修改（UU）或都新增（AA）的文字檔才能逐段處理；刪除與修改的衝突改為整個檔案選擇
    if (!info.resolved && (info.xy === 'UU' || info.xy === 'AA') && w.exists && !w.binary && !w.tooLarge && !w.readOnly) {
      this.segs = C.parseConflicts(w.text);
      this.conflicts = this.segs.filter((x) => x.type === 'conflict');
      this.eol = w.text.includes('\r\n') ? '\r\n' : '\n';
    }
    this.renderHead();
    this.renderBody();
  }

  get names() {
    const c = this.conflicts[0] || {};
    const state = this.info.state || (/Stashed changes/i.test(c.theirsLabel || '') ? 'stash' : '');
    return C.sideNames(state, c.oursLabel, c.theirsLabel);
  }

  renderHead() {
    const info = this.info;
    const n = this.conflicts.length;
    const done = Object.keys(this.choices).length;
    let html = `<span class="p" title="${esc(info.path)}">${esc(info.path)}</span><span class="st g-U">${esc(info.resolved ? '已解決' : info.label || '衝突')}</span>`;
    if (n) html += `<span class="${done === n ? 'add' : 'del'}">已處理 ${done} / ${n}</span>`;
    html += '<span class="sp"></span>';
    if (n) {
      html += '<button class="ib sm" data-act="prev" title="上一個衝突">↑</button><button class="ib sm" data-act="next" title="下一個衝突">↓</button>'
        + '<button class="secondary sm" data-act="allOurs" title="每一處都採用目前的版本">全部採用目前</button><button class="secondary sm" data-act="allTheirs" title="每一處都採用傳入的版本">全部採用傳入</button>'
        + `<button class="secondary sm" data-act="reset" ${done ? '' : 'disabled'}>重來</button>`
        + `<button class="sm" data-act="save" ${done === n ? '' : 'disabled'} title="${done === n ? '寫入檔案並標示為已解決（git add）' : '每一處衝突都選擇後才能儲存'}">✓ 儲存並標示已解決</button>`;
    }
    if (!info.resolved && info.working.exists) html += '<button class="ib sm" data-act="open" title="用預設的應用程式開啟檔案，自己編輯">↗</button>';
    html += '<button class="ib sm" data-act="reload" title="重新讀取">⟳</button>';
    this.head.innerHTML = html;
  }

  renderBody() {
    const info = this.info;
    if (info.resolved) {
      this.body.innerHTML = '<div class="cfile"><h3>這個檔案的衝突已經解決</h3><p>它已經不在衝突清單中。</p><div class="acts"><button class="secondary" data-act="close">關閉分頁</button></div></div>';
      return;
    }
    if (!this.segs) { this.renderFileChoice(); return; }
    if (!this.conflicts.length) {
      this.body.innerHTML = '<div class="cfile"><h3>檔案中已經沒有衝突標記</h3><p>看起來你已經在其他地方編輯好這個檔案了。確認內容正確後，標示為已解決。</p>'
        + '<div class="acts"><button data-act="mark">✓ 標示為已解決</button><button class="secondary" data-act="open">開啟檔案</button></div></div>';
      return;
    }
    const nm = this.names;
    const out = [`<p class="cintro">這個檔案有 <b>${this.conflicts.length}</b> 處衝突：同一段內容兩邊都改了，Git 不知道要用哪一邊。每一處選擇採用 <b class="o">${esc(nm.ours)}</b>、<b class="t">${esc(nm.theirs)}</b>、兩者都保留，或自己編輯，全部處理完後按「儲存並標示已解決」。</p>`];
    this.segs.forEach((sg, si) => {
      if (sg.type === 'text') { out.push(this.textHtml(sg.text, si, si === 0, si === this.segs.length - 1)); return; }
      const i = sg.index;
      const c = this.choices[i];
      const pick = (k, label, cls = '') => `<button class="secondary sm ${cls}${c === k ? ' on' : ''}" data-pick="${k}">${label}</button>`;
      let res = '';
      if (c && typeof c === 'object') {
        res = `<div class="cres"><div class="lb">結果（手動編輯）<span class="sp"></span><button class="ib sm" data-pick="undo" title="取消這一處的選擇">↶</button></div><textarea data-edit="${i}" spellcheck="false" rows="${Math.min(20, Math.max(3, c.text.split('\n').length + 1))}">${esc(c.text)}</textarea></div>`;
      } else if (c) {
        res = `<div class="cres"><div class="lb">結果<span class="sp"></span><button class="ib sm" data-pick="undo" title="取消這一處的選擇">↶</button></div><pre>${esc(C.resolved(sg, c, this.eol))}</pre></div>`;
      }
      out.push(`<div class="cblk${c ? ' done' : ''}" data-i="${i}"><div class="bh"><span class="t">衝突 ${i + 1}</span><span class="chip">${c ? '已處理' : '未處理'}</span><span class="sp"></span>`
        + `${pick('ours', `<span class="o">◀</span> 採用目前`)}${pick('theirs', `採用傳入 <span class="th">▶</span>`)}${pick('both', '兩者（目前在前）')}${pick('both-theirs', '兩者（傳入在前）')}`
        + `<button class="secondary sm${c && typeof c === 'object' ? ' on' : ''}" data-pick="edit">✎ 編輯</button></div>`
        + `<div class="sides"><div class="side o"><div class="lb">${esc(nm.ours)}</div><pre>${esc(sg.ours)}</pre></div><div class="side t"><div class="lb">${esc(nm.theirs)}</div><pre>${esc(sg.theirs)}</pre></div></div>`
        + `${sg.base !== null ? `<details class="cbase"><summary>共同祖先（修改前的版本）</summary><pre>${esc(sg.base)}</pre></details>` : ''}${res}</div>`);
    });
    this.body.innerHTML = out.join('');
  }

  /** 衝突之間的內容：太長時只顯示靠近衝突的幾行 */
  textHtml(text, si, first, last) {
    const lines = C.splitKeep(text);
    const K = 4;
    if (lines.length <= K * 2 + 2 || this.expanded.has(si)) return `<pre class="ctext">${esc(text)}</pre>`;
    const head = first ? [] : lines.slice(0, K);
    const tail = last ? [] : lines.slice(-K);
    const hidden = lines.length - head.length - tail.length;
    return `${head.length ? `<pre class="ctext">${esc(head.join(''))}</pre>` : ''}<button class="cfold" data-fold="${si}">⋯ 顯示 ${hidden} 行沒有衝突的內容</button>${tail.length ? `<pre class="ctext">${esc(tail.join(''))}</pre>` : ''}`;
  }

  /** 無法逐段處理的衝突（刪除與修改、二進位、Big5）：整個檔案選擇一方 */
  renderFileChoice() {
    const info = this.info;
    const w = info.working;
    const reason = { DU: '你這邊刪除了這個檔案，但對方修改了它。', UD: '你這邊修改了這個檔案，但對方刪除了它。', AU: '只有你這邊新增了這個檔案。', UA: '只有對方新增了這個檔案。', DD: '兩邊都刪除了這個檔案。' }[info.xy]
      || (w.binary ? '這是二進位檔案，無法逐段合併。' : w.readOnly ? '這個檔案不是 UTF-8 編碼，無法在這裡逐段編輯。' : w.tooLarge ? '檔案太大，無法在這裡逐段編輯。' : '這個檔案無法逐段合併。');
    const acts = [];
    if (info.ours && info.theirs) {
      acts.push('<button data-act="takeOurs">採用目前的版本</button>', '<button data-act="takeTheirs">採用傳入的版本</button>');
    } else if (w.exists) {
      acts.push(`<button data-act="mark">保留檔案（${info.ours ? '目前' : '傳入'}的版本）</button>`);
    }
    acts.push('<button class="danger" data-act="remove">刪除檔案</button>');
    if (w.exists) acts.push('<button class="secondary" data-act="open">開啟檔案</button>');
    this.body.innerHTML = `<div class="cfile"><h3>${esc(info.label || '衝突')}</h3><p>${esc(reason)}請選擇要保留哪一個版本，或刪除這個檔案。</p><div class="acts">${acts.join('')}</div></div>`;
  }

  jump(dir, from) {
    const blocks = $$('.cblk', this.body);
    if (!blocks.length) return;
    let i = from === undefined ? (this.cur ?? -1) : from;
    // 往下找下一個未處理的衝突
    if (from !== undefined) {
      const next = blocks.find((b) => Number(b.dataset.i) > from && !this.choices[Number(b.dataset.i)]);
      if (!next) return;
      i = Number(next.dataset.i);
    } else i = Math.max(0, Math.min(blocks.length - 1, i + dir));
    this.cur = i;
    for (const b of blocks) b.classList.toggle('cur', Number(b.dataset.i) === i);
    const el = blocks.find((b) => Number(b.dataset.i) === i);
    if (el) this.body.scrollTop = Math.max(0, el.offsetTop - 40);
  }

  async action(act) {
    const p = this.tab.src.path;
    if (act === 'prev' || act === 'next') { this.jump(act === 'next' ? 1 : -1); return; }
    if (act === 'reload') { await this.load(); return; }
    if (act === 'close') { closeTab(this.tab.id); return; }
    if (act === 'open') { await api('openFile', { path: p }); return; }
    if (act === 'allOurs' || act === 'allTheirs') {
      for (const c of this.conflicts) this.choices[c.index] = act === 'allOurs' ? 'ours' : 'theirs';
      this.renderBody();
      this.renderHead();
      return;
    }
    if (act === 'reset') { this.choices = {}; this.renderBody(); this.renderHead(); return; }
    if (act === 'save') {
      const text = C.resolveConflicts(this.segs, this.choices);
      if (C.hasMarkers(text) && !await confirmBox('結果中還有衝突標記（<<<<<<< ======= >>>>>>>），仍要標示為已解決嗎？', '仍要儲存', { type: 'warning' })) return;
      await api('conflict:resolve', { path: p, text, bom: !!this.info.working.bom });
    } else if (act === 'takeOurs' || act === 'takeTheirs') {
      await api('conflict:take', { path: p, side: act === 'takeOurs' ? 'ours' : 'theirs' });
    } else if (act === 'mark') {
      await api('conflict:mark', { path: p });
    } else if (act === 'remove') {
      if (!await confirmBox(`刪除 ${p}？`, '刪除', { type: 'warning' })) return;
      await api('conflict:mark', { path: p, remove: true });
    } else return;
    notice(`${p} 已標示為已解決`, 'ok');
    await afterResolved(this.tab);
  }

  onStatus() {
    if (this.info && !this.info.resolved && st.status && !st.status.conflict.some((c) => c.path === this.tab.src.path)) {
      this.info.resolved = true;
      this.renderHead();
      this.renderBody();
    }
  }
}

async function afterResolved(tab) {
  await refresh();
  closeTab(tab.id);
  const s = st.status;
  if (s.conflict.length) openConflict(s.conflict[0].path);
  else if (s.state) notice(s.state === 'merge' ? '衝突都已解決，按「完成合併」提交合併結果' : '衝突都已解決，按「繼續」', 'ok');
}

function openConflict(p) {
  let t = st.tabs.find((x) => x.kind === 'conflict' && x.src.path === p);
  if (!t) {
    t = { kind: 'conflict', src: { path: p }, title: `⚡ ${basename(p)}`, tip: `解決衝突：${p}` };
    t.view = new ConflictView(t);
    addTab(t);
  } else activate(t.id);
  t.view.load().catch(fail);
  setSide('changes');
}

/* ───────────── 輸出 ───────────── */

function outHtml(e) {
  const d = new Date(e.time);
  const tm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const body = [e.output, !e.ok && e.message && !e.output.includes(e.message) ? `→ ${e.message}` : ''].filter(Boolean).join('\n');
  return `<div class="oe${e.ok ? '' : ' err'}"><div class="h"><span class="tm">${tm}</span><span class="cmd">${esc(e.cmd)}</span><span class="ms">${e.ms} ms</span></div>${body ? `<pre>${esc(body)}</pre>` : ''}</div>`;
}

async function toggleOutput(show) {
  const p = $('#outPanel');
  p.hidden = show === undefined ? !p.hidden : !show;
  $('#outBtn').classList.toggle('on', !p.hidden);
  if (!p.hidden) {
    const list = await td.invoke('output');
    $('#outList').innerHTML = list.map(outHtml).join('') || '<div class="empty-msg">還沒有執行任何會修改儲存庫或連線的 git 指令。</div>';
    $('#outList').scrollTop = 1e9;
  }
}

/* ───────────── 側欄 ───────────── */

function setSide(side) {
  st.side = side;
  for (const b of $$('#sideTabs button')) b.classList.toggle('on', b.dataset.side === side);
  $('#changesPane').hidden = side !== 'changes';
  $('#branchesPane').hidden = side !== 'branches';
  $('#stashPane').hidden = side !== 'stash';
  if (side === 'branches' && st.rid) { renderBranches(); loadBranches().catch(fail); }
  if (side === 'stash') renderStashes();
}

function initSplit() {
  const split = $('#sideSplit');
  const w = store.get('sideW', 0);
  if (w) document.body.style.setProperty('--side-w', `${w}px`);
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    split.classList.add('drag');
    const move = (ev) => document.body.style.setProperty('--side-w', `${Math.max(200, Math.min(innerWidth * 0.6, ev.clientX))}px`);
    const up = (ev) => {
      split.classList.remove('drag');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      store.set('sideW', Math.max(200, Math.min(innerWidth * 0.6, ev.clientX)));
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}

/* ───────────── 指令 ───────────── */

async function runCommand(command) {
  if (command && typeof command === 'object') return importCommand(command);
  if (command === 'sshKeys') return sshPanel();
  if (command === 'clone') return cloneFlow();
  if (command === 'addRepo') return addRepoFlow();
  if (!st.rid) { notice('請先選擇或加入儲存庫', 'err'); return; }
  if (command === 'pull') return pullFlow();
  if (command === 'push') return pushFlow();
  if (command === 'fetch') return fetchFlow();
}

const ACTIONS = {
  clone: () => cloneFlow(),
  addRepo: () => addRepoFlow(),
  openIn: () => openInFlow(),
  shareFile: shareFileFlow,
  sshKeys: () => sshPanel(),
  initRepo: () => initRepoFlow(),
  removeRepo: removeRepoFlow,
  renameRepo: renameRepoFlow,
  revealRepo: () => api('reveal'),
  openTerminal: () => api('openTerminal'),
  copyPath: () => copyText(repo().root),
  identity: () => identityFlow(),
  fetch: fetchFlow,
  pull: () => pullDialog(),
  push: () => pushDialog(),
  newBranch: () => newBranchFlow(),
  mergeInto: () => mergeFlow(),
  stashPush: stashFlow,
  reflog: () => openReflog(),
  worktreeAdd: () => (st.worktrees ? addWorktreeFlow() : loadExtras().then(addWorktreeFlow)),
  submoduleUpdate: () => submoduleUpdateFlow(),
  refresh: () => (st.rid ? withLoading('正在重新整理…', refreshAll) : null),
  clearOut: () => { $('#outList').innerHTML = ''; },
  closeOut: () => toggleOutput(false),
};

/* ───────────── 啟動 ───────────── */

async function init() {
  try {
    await setup();
  } finally {
    loading.leave(); // 收起 index.html 預設開著的「正在啟動」
    markReady();
  }
  const pending = await td.invoke('takePending');
  if (pending) await runCommand(pending);
}

async function setup() {
  st.diffMode = store.get('diffMode', 'sbs');
  st.graphAll = store.get('graphAll', true);
  st.diffWs = store.get('diffWs', false);
  st.diffWrap = store.get('diffWrap', true);
  st.commitOpts = { ...st.commitOpts, ...store.get('commitOpts', {}) };
  initSplit();
  initChanges();
  initBranches();
  initStashes();
  initTabs();
  initSsh();
  initRebase();

  // 線圖分頁固定在第一個
  const g = { kind: 'graph', fixed: true, title: '⑂ 線圖', tip: '分支線圖與提交歷史' };
  g.view = new GraphView();
  addTab(g);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('.menu-wrap > button') && !e.target.closest('#branchBtn') && !e.target.closest('[data-act="mergeInto"]') && !e.target.closest('[data-ssh="keyMenu"]') && !e.target.closest('[data-menu]')) closeMenus();
    const a = e.target.closest('[data-act]');
    if (a && !a.closest('.view') && !a.closest('#modal') && ACTIONS[a.dataset.act]) {
      closeMenus();
      Promise.resolve(ACTIONS[a.dataset.act]()).catch(fail);
    }
  });
  $('#addBtn').onclick = () => { const m = $('#addMenu'); const open = m.hidden; closeMenus(); m.hidden = !open; };
  $('#repoMenuBtn').onclick = () => {
    const m = $('#repoMenu');
    const open = m.hidden;
    closeMenus();
    m.hidden = !open || !repo();
    if (!m.hidden) refreshTargets();
  };
  $('#branchBtn').onclick = (e) => branchMenu(e.currentTarget).catch(fail);
  $('#outBtn').onclick = () => toggleOutput().catch(fail);
  $('#cancelBtn').onclick = () => td.invoke('cancel').catch(fail);
  $('#repoSel').onchange = (e) => selectRepo(e.target.value).catch(fail);
  for (const b of $$('#sideTabs button')) b.onclick = () => setSide(b.dataset.side);
  $('#commitBtn').onclick = () => commitFlow().catch(fail);
  $('#amend').onchange = () => onAmendToggle().catch(fail);
  $('#msg').addEventListener('input', () => { st.msgTouched = true; renderMsgLen(); });
  $('#commitOpts').onclick = commitOptsMenu;
  $('#msgHist').onclick = msgHistMenu;
  $('#msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitFlow().catch(fail); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (sshOpen() && $('#modal').hidden && $$('.menu').every((m) => m.hidden)) { closeSsh(); return; }
      closeMenus();
    }
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'w' && st.active) {
      const t = st.tabs.find((x) => x.id === st.active);
      if (t && !t.fixed) { e.preventDefault(); closeTab(t.id); }
    }
  });

  td.on('progress', (p) => { st.progress = p; renderProgress(); });
  td.on('busy', (b) => { st.busy = b; renderProgress(); });
  td.on('output', (e) => {
    if ($('#outPanel').hidden) return;
    const list = $('#outList');
    const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
    if (list.querySelector('.empty-msg')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', outHtml(e));
    if (atEnd) list.scrollTop = 1e9;
  });
  let changedTimer = null;
  td.on('repoChanged', ({ id }) => {
    if (id !== st.rid || st.busy || st.progress) return;
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => refreshAll(), 300);
  });
  td.on('settingsChanged', ({ settings }) => { if (st.info) st.info.settings = settings; });
  // 啟動中收到的指令（例如程式碼編輯器要求開啟專案）等初始化完成再處理
  td.on('command', ({ command }) => { td.invoke('takePending').catch(() => {}); ready.then(() => runCommand(command)).catch(fail); });

  // 回到這個畫面時重新讀取狀態（檔案可能在其他程式中修改過）
  let lastFocus = 0;
  const onBack = () => {
    if (document.hidden || !st.rid || st.busy || st.progress || loading.depth) return;
    const now = Date.now();
    if (now - lastFocus < 1500) return;
    lastFocus = now;
    refresh();
  };
  addEventListener('focus', onBack);
  document.addEventListener('visibilitychange', onBack);
  setInterval(() => { if (!document.hidden && st.rid && !st.busy && !st.progress && !loading.depth && $('#modal').hidden) refresh(); }, 15000);

  loading.step('讀取設定與儲存庫清單');
  st.info = await td.invoke('info');
  st.repos = st.info.repos;
  $('#gitVer').textContent = st.info.gitVersion ? st.info.gitVersion : '⚠️ 找不到 git：請先安裝 Git（https://git-scm.com），或在擴充設定中指定 git 執行檔位置。';
  if (st.info.busy) { st.busy = st.info.busy; renderProgress(); }
  const last = st.repos.find((r) => r.id === st.info.lastRepo) ? st.info.lastRepo : (st.repos[0] && st.repos[0].id);
  await selectRepo(last || null);
  refreshTargets();
}

init().catch(fail);
