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
