'use strict';
/**
 * 在終端機開啟資料夾（另開系統的終端機視窗，工作目錄是指定的資料夾）。
 *
 * - macOS：`open -a Terminal <資料夾>`；設定的終端機是 App 名稱（例如 iTerm、Warp）或 .app 路徑時同樣用 open -a。
 * - Windows：依序嘗試 Windows Terminal（wt.exe -d）、PowerShell、cmd，後兩者以 detached 開新的主控台視窗。
 * - Linux：依序嘗試 x-terminal-emulator、gnome-terminal、konsole、xfce4-terminal、kitty、alacritty、xterm。
 * - 設定的終端機是執行檔路徑（含路徑分隔符號、不是 .app）時：直接執行，工作目錄設為資料夾，不帶參數；
 *   Windows 的 .cmd／.bat 透過 cmd.exe /c 執行（Node.js 不能直接執行批次檔）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isMacApp = (v) => /\.app\/?$/i.test(v) || !/[\\/]/.test(v);

/**
 * 依平台列出要依序嘗試的指令。
 * @returns {{ cmd: string, args: string[], wait?: boolean, detached?: boolean, verbatim?: boolean }[]}
 *   wait：等指令結束並以結束碼判斷成功（open -a 找不到 App 時會回傳非 0）；否則程式啟動就算成功。
 */
function plan(platform, dir, custom = '') {
  const c = String(custom || '').trim();
  if (platform === 'darwin') {
    if (c && !isMacApp(c)) return [{ cmd: c, args: [], detached: true }];
    return [{ cmd: 'open', args: ['-a', c || 'Terminal', dir], wait: true }];
  }
  if (c && platform === 'win32' && /\.(cmd|bat)$/i.test(c)) return [{ cmd: 'cmd.exe', args: ['/d', '/s', '/c', `"${c}"`], verbatim: true, detached: true }];
  if (c) return [{ cmd: c, args: [], detached: true }];
  if (platform === 'win32') {
    return [
      { cmd: 'wt.exe', args: ['-d', dir] },
      { cmd: 'powershell.exe', args: ['-NoExit'], detached: true },
      { cmd: 'cmd.exe', args: ['/K'], detached: true },
    ];
  }
  return [
    { cmd: 'x-terminal-emulator', args: [] },
    { cmd: 'gnome-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'konsole', args: ['--workdir', dir] },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'kitty', args: ['--directory', dir] },
    { cmd: 'alacritty', args: ['--working-directory', dir] },
    { cmd: 'xterm', args: [] },
  ].map((x) => ({ ...x, detached: true }));
}

/** 執行一個候選指令；找不到程式時回傳 false，其他失敗丟出錯誤 */
function attempt(c, cwd) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(c.cmd, c.args, {
        cwd,
        detached: !!c.detached,
        stdio: c.wait ? ['ignore', 'ignore', 'pipe'] : 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: !!c.verbatim,
      });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EACCES') return resolve(false);
      return reject(e);
    }
    let settled = false;
    const end = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    child.on('error', (e) => {
      if (e.code === 'ENOENT' || e.code === 'EACCES') end(resolve, false);
      else end(reject, e);
    });
    if (c.wait) {
      let err = '';
      child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      child.on('close', (code) => {
        if (code === 0) end(resolve, true);
        else end(reject, new Error(`無法開啟終端機「${c.args[1]}」${err.trim() ? `：${err.trim()}` : ''}。請到設定「終端機程式」確認名稱`));
      });
    } else {
      child.on('spawn', () => { child.unref(); end(resolve, true); });
    }
  });
}

/**
 * 在終端機開啟 dir。
 * @param {string} dir 資料夾（絕對路徑）
 * @param {string} [custom] 設定 gitTool.terminal
 * @returns {Promise<{ dir: string, command: string }>}
 */
async function open(dir, custom = '', { platform = process.platform, run = attempt } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('資料夾路徑不正確');
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error('資料夾不存在'); }
  if (!st.isDirectory()) throw new Error('請選擇資料夾');
  const c = String(custom || '').trim();
  const notFound = () => new Error(`找不到終端機程式「${c}」，請到設定「終端機程式」確認路徑`);
  // 填的是路徑（不是 macOS 的 App 名稱）時先確認檔案存在
  if (c && /[\\/]/.test(c) && !(platform === 'darwin' && isMacApp(c)) && !fs.existsSync(c)) throw notFound();
  for (const c of plan(platform, dir, custom)) {
    if (await run(c, dir)) return { dir, command: c.cmd };
  }
  throw c ? notFound() : new Error('找不到可用的終端機程式，請到設定「終端機程式」指定');
}

module.exports = { plan, open, isMacApp };
