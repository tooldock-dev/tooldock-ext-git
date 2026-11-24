'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../ui/git-core');

const commits = (spec) => spec.map(([hash, ...parents]) => ({ hash, parents }));

test('線圖：直線歷史都在第 0 欄', () => {
  const g = C.layoutGraph(commits([['c', 'b'], ['b', 'a'], ['a']]));
  assert.deepEqual(g.nodes.map((n) => n.col), [0, 0, 0]);
  assert.equal(g.width, 1);
  // 每一列：上半段匯入（第 0 列沒有）、下半段往父提交
  assert.ok(g.edges.every((e) => e.x1 === 0 && e.x2 === 0));
});

test('線圖：分支與合併', () => {
  // m 合併了 f（feature）到 b（main）
  //   m
  //   |\
  //   b f
  //   |/
  //   a
  const g = C.layoutGraph(commits([['m', 'b', 'f'], ['f', 'a'], ['b', 'a'], ['a']]));
  assert.deepEqual(g.nodes.map((n) => n.col), [0, 1, 0, 0]);
  assert.equal(g.nodes[0].merge, true);
  assert.equal(g.width, 2);
  // f 的父提交 a 由第 0 欄（b 的父提交）先等，所以 f 這一欄在 a 匯入第 0 欄
  const intoA = g.edges.filter((e) => e.y2 === 3.5);
  assert.deepEqual(intoA.map((e) => e.x1).sort(), [0, 1]);
  assert.ok(intoA.every((e) => e.x2 === 0));
  // 合併的兩條線顏色不同
  const out = g.edges.filter((e) => e.y1 === 0.5);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].color, out[1].color);
});

test('線圖：兩個分支的最新提交各自開欄，沒有出現的父提交延伸到底', () => {
  const g = C.layoutGraph(commits([['x', 'p'], ['y', 'q']]));
  assert.deepEqual(g.nodes.map((n) => n.col), [0, 1]);
  // 第 1 列時第 0 欄（等 p）直直穿過
  assert.ok(g.edges.some((e) => e.x1 === 0 && e.x2 === 0 && e.y1 === 1 && e.y2 === 2));
});

test('線圖：空欄會重複使用', () => {
  // d 與 e 是兩個分支，e 合併後該欄釋放，之後的新分支 z 重複使用
  const g = C.layoutGraph(commits([['m', 'a', 'e'], ['e', 'a'], ['a'], ['z']]));
  assert.equal(g.nodes[3].col, 0);
  assert.equal(g.width, 2);
});

test('衝突：解析標記並保留換行字元', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\nb\r\n';
  const segs = C.parseConflicts(text);
  assert.equal(segs.length, 3);
  const c = segs[1];
  assert.equal(c.type, 'conflict');
  assert.equal(c.ours, 'ours\r\n');
  assert.equal(c.theirs, 'theirs\r\n');
  assert.equal(c.oursLabel, 'HEAD');
  assert.equal(c.theirsLabel, 'feature');
  assert.equal(c.base, null);
  assert.equal(C.resolveConflicts(segs), text, '沒有選擇時還原成原文');
  assert.equal(C.resolveConflicts(segs, { 0: 'ours' }), 'a\r\nours\r\nb\r\n');
  assert.equal(C.resolveConflicts(segs, { 0: 'theirs' }), 'a\r\ntheirs\r\nb\r\n');
  assert.equal(C.resolveConflicts(segs, { 0: 'both' }), 'a\r\nours\r\ntheirs\r\nb\r\n');
  assert.equal(C.resolveConflicts(segs, { 0: 'both-theirs' }), 'a\r\ntheirs\r\nours\r\nb\r\n');
  assert.equal(C.resolveConflicts(segs, { 0: { text: 'x\r\n' } }), 'a\r\nx\r\nb\r\n');
  assert.equal(C.hasMarkers(text), true);
  assert.equal(C.hasMarkers(C.resolveConflicts(segs, { 0: 'ours' })), false);
});

test('衝突：diff3 格式、多個衝突、檔尾沒有換行', () => {
  const text = '<<<<<<< ours\nA\n||||||| base\nO\n=======\nB\n>>>>>>> theirs\nmid\n<<<<<<< ours\n=======\nC\n>>>>>>> theirs';
  const segs = C.parseConflicts(text);
  const cs = segs.filter((s) => s.type === 'conflict');
  assert.equal(cs.length, 2);
  assert.equal(cs[0].base, 'O\n');
  assert.equal(cs[0].baseLabel, 'base');
  assert.equal(cs[1].ours, '');
  assert.equal(cs[1].theirs, 'C\n');
  assert.equal(C.resolveConflicts(segs, { 0: 'base', 1: 'theirs' }), 'O\nmid\nC\n');
  assert.equal(C.resolveConflicts(segs), text);
});

test('衝突：不完整的標記當作一般文字', () => {
  const text = 'x\n<<<<<<< HEAD\nonly ours\n';
  const segs = C.parseConflicts(text);
  assert.deepEqual(segs, [{ type: 'text', text }]);
  assert.equal(C.hasMarkers('a\n=======\nb\n'), false);
  // 一般文字裡的 ======= 不受影響
  assert.equal(C.resolveConflicts(C.parseConflicts('a\n=======\n')), 'a\n=======\n');
});

test('衝突：兩者都保留時補上換行', () => {
  const segs = C.parseConflicts('<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n');
  assert.equal(C.resolved(segs[0], 'both'), 'x\ny\n');
  assert.equal(C.resolved({ ours: 'x', theirs: 'y' }, 'both'), 'x\ny');
  assert.equal(C.resolveConflicts(C.parseConflicts('<<<<<<< a\nx\n=======\ny\n>>>>>>> b\nz\n'), { 0: { text: 'manual' } }), 'manual\nz\n', '手動結果補上換行');
});

test('差異比對與摺疊', () => {
  const a = C.toLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
  const b = C.toLines('1\n2\n3\n4\n5x\n6\n7\n8\n9\n10\n11\n');
  const ops = C.diffLines(a, b);
  assert.deepEqual(C.diffStats(ops), { added: 2, removed: 1 });
  const rows = C.fold(C.sideBySide(ops), 1);
  assert.ok(rows.some((r) => r.kind === 'fold'));
  assert.equal(C.unified(ops).filter((r) => r.kind !== 'eq').length, 3);
});

test('時間格式', () => {
  const now = new Date(2026, 10, 22, 12, 0, 0).getTime();
  assert.equal(C.ago(now - 30e3, now), '剛剛');
  assert.equal(C.ago(now - 5 * 60e3, now), '5 分鐘前');
  assert.equal(C.ago(now - 3 * 3600e3, now), '3 小時前');
  assert.equal(C.ago(now - 2 * 86400e3, now), '2 天前');
  assert.equal(C.ago(new Date(2026, 0, 5).getTime(), now), '1/5');
  assert.equal(C.ago(new Date(2024, 0, 5).getTime(), now), '2024/1/5');
  assert.equal(C.formatDate(new Date(2026, 0, 5, 9, 7).getTime()), '2026-01-05 09:07');
});

test('逐行暫存：只套用選取的新增與刪除', () => {
  const a = 'l1\nl2\nl3\nl4\n';
  const b = 'l1\nX\nl3\nl4\nY\n';
  // 變更：刪除 l2（a=1）、新增 X（b=1）、新增 Y（b=4）
  assert.equal(C.applyPartial(a, b, { add: [4] }), 'l1\nl2\nl3\nl4\nY\n');
  assert.equal(C.applyPartial(a, b, { del: [1], add: [1] }), 'l1\nX\nl3\nl4\n');
  assert.equal(C.applyPartial(a, b, { del: [1] }), 'l1\nl3\nl4\n');
  // invert：把選取的變更退回（取消暫存、捨棄）
  assert.equal(C.applyPartial(a, b, { add: [4], invert: true, target: 'b' }), 'l1\nX\nl3\nl4\n');
  assert.ok(C.coversAll(a, b, { del: [1], add: [1, 4] }));
  assert.ok(!C.coversAll(a, b, { del: [1], add: [1] }));
});

test('逐行暫存：保留寫入那一側的行尾，檔尾沒有換行的行接到中間時補上', () => {
  const a = 'a\r\nb\r\n';
  const b = 'a\nb\nc'; // 工作目錄是 LF、最後一行沒有換行
  assert.equal(C.applyPartial(a, b, { add: [2] }), 'a\r\nb\r\nc');
  const a2 = 'x\ny';
  const b2 = 'x\ny\nz\n';
  // y 沒有換行；只暫存 z 時 y 要補換行
  assert.equal(C.applyPartial(a2, b2, { del: [1], add: [1, 2] }), 'x\ny\nz\n');
  assert.deepEqual(C.rawLines('a\r\nb\rc\n\nd'), ['a\r\n', 'b\r', 'c\n', '\n', 'd']);
  assert.equal(C.rawLines('a\r\nb\rc\n\nd').length, C.toLines('a\r\nb\rc\n\nd').length);
  assert.equal(C.dominantEol('a\r\nb\r\nc\n'), '\r\n');
  assert.notEqual(C.textHash('abc'), C.textHash('abd'));
});

test('樹狀檢視：資料夾分組並合併單一子資料夾', () => {
  const t = C.buildTree([{ path: 'desktop/scripts/a.js' }, { path: 'desktop/scripts/b.js' }, { path: 'docs/manual/img/x.png' }, { path: 'README.md' }]);
  assert.deepEqual(t.items.map((x) => x.path), ['README.md']);
  assert.deepEqual(t.dirs.map((d) => d.name), ['desktop/scripts', 'docs/manual/img']);
  assert.equal(t.dirs[0].path, 'desktop/scripts');
  assert.equal(t.dirs[0].items.length, 2);
  const br = C.buildTree([{ n: 'claude/a' }, { n: 'claude/b' }, { n: 'main' }], (x) => x.n);
  assert.deepEqual(br.dirs.map((d) => d.name), ['claude']);
});

test('在終端機開啟：依平台與設定選擇指令', () => {
  const T = require('../backend/terminal');
  assert.deepEqual(T.plan('darwin', '/r'), [{ cmd: 'open', args: ['-a', 'Terminal', '/r'], wait: true }]);
  assert.deepEqual(T.plan('darwin', '/r', 'iTerm')[0].args, ['-a', 'iTerm', '/r']);
  assert.equal(T.plan('win32', 'C:\\r')[0].cmd, 'wt.exe');
  assert.equal(T.plan('linux', '/r')[0].cmd, 'x-terminal-emulator');
});
