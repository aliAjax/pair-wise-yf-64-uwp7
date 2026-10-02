// 纯逻辑测试：容量重算、候补升降、插话累加、旧数据升级、多窗口三路合并。
// 运行：node scripts/test-time.mjs（esbuild 即时编译 TS）
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const out = join(tmpdir(), `time-lib-${process.pid}.mjs`);
await build({
  entryPoints: ['src/lib/time.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
});
writeFileSync(out, (await import('node:fs')).readFileSync(out));
const T = await import(out);

const makeSpeech = (overrides = {}) => ({
  id: 's',
  roomId: 'hall-a',
  speaker: '代表',
  delegation: '代表团',
  language: '中文',
  topic: '议题',
  plannedSeconds: 600,
  remainingSeconds: 600,
  status: 'queued',
  updatedAt: '2026-01-01T00:00:00.000Z',
  order: 0,
  ...overrides,
});

const baseState = () => ({
  version: 2,
  rooms: [
    { id: 'hall-a', name: 'A厅', topic: '议题甲', simultaneousChannels: 6, capacitySeconds: 1000 },
    { id: 'hall-b', name: 'B厅', topic: '议题乙', simultaneousChannels: 4, capacitySeconds: 2400 },
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    makeSpeech({ id: 's1', speaker: '甲', order: 0 }),
    makeSpeech({ id: 's2', speaker: '乙', order: 1 }),
  ],
  channels: [],
  terms: [],
  captions: [],
  audits: [],
  adjustments: [],
  lowLatency: false,
});

test('migrateState: 旧版数据按原计划时长补齐容量与剩余时长', () => {
  const legacy = {
    rooms: [{ id: 'hall-a', name: 'A厅', topic: 't', simultaneousChannels: 6 }],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 's1', roomId: 'hall-a', speaker: '甲', plannedSeconds: 600, status: 'queued' },
      { id: 's2', roomId: 'hall-a', speaker: '乙', plannedSeconds: 600, status: 'queued' },
    ],
    channels: [],
    terms: [],
    captions: [],
    audits: [],
  };
  const migrated = T.migrateState(legacy);
  assert.equal(migrated.version, T.CURRENT_VERSION);
  assert.equal(migrated.rooms[0].capacitySeconds, 3600); // 原计划 1200s，向上取整到 300s 倍数且不低于 3600
  assert.equal(migrated.speechQueue[0].remainingSeconds, 600);
  assert.equal(migrated.speechQueue[0].order, 0);
  assert.equal(migrated.adjustments.length, 0);
});

test('computeBudget: 超出容量时给出超秒数，后续时段按顺序预计起止', () => {
  const state = baseState();
  const budget = T.computeBudget(state, 'hall-a');
  assert.equal(budget.used, 1200);
  assert.equal(budget.overSeconds, 200);
  assert.equal(budget.rows[0].start, 0);
  assert.equal(budget.rows[0].end, 600);
  assert.equal(budget.rows[1].start, 600);
  assert.equal(budget.rows[1].end, 1200);
});

test('recomputeHall: 超出容量把排在最后的代表降为候补', () => {
  const state = baseState();
  const result = T.recomputeHall(state, 'hall-a');
  assert.deepEqual(result.demoted, ['s2']);
  assert.equal(state.speechQueue.find((s) => s.id === 's2').status, 'alternate');
  assert.equal(T.computeBudget(state, 'hall-a').overSeconds, 0);
});

test('recomputeHall: 提前结束空出时间，候补按顺序补回', () => {
  const state = baseState();
  T.recomputeHall(state, 'hall-a'); // s2 降为候补
  const s1 = state.speechQueue.find((s) => s.id === 's1');
  s1.status = 'done';
  s1.remainingSeconds = 300; // 提前结束，退回 300s
  const result = T.recomputeHall(state, 'hall-a');
  assert.deepEqual(result.promoted, ['s2']);
  assert.equal(state.speechQueue.find((s) => s.id === 's2').status, 'queued');
  const budget = T.computeBudget(state, 'hall-a');
  assert.equal(budget.used, 900); // s1 实际只用 300 + s2 计划 600
  assert.equal(budget.returnedSeconds, 300);
});

test('插话/调剂按次累加进已用时间，再次触发降级', () => {
  const state = baseState();
  T.recomputeHall(state, 'hall-a'); // s2 候补
  state.speechQueue.find((s) => s.id === 's2').status = 'queued'; // 手动补回，模拟容量足够
  state.adjustments.push({ id: 'a1', roomId: 'hall-a', at: T.now?.() ?? '', kind: 'interjection', deltaSeconds: 500, note: '临时动议' });
  const budget = T.computeBudget(state, 'hall-a');
  assert.equal(budget.bookedAdjustments, 500);
  assert.equal(budget.used, 1700);
  const result = T.recomputeHall(state, 'hall-a');
  assert.deepEqual(result.demoted, ['s2', 's1']); // 超 700s：s2 降级后仍超 100s，s1 也降为候补
  assert.equal(T.computeBudget(state, 'hall-a').overSeconds, 0);
});

test('切换会议厅互不串账：B厅预算独立', () => {
  const state = baseState();
  state.adjustments.push({ id: 'a1', roomId: 'hall-a', at: '', kind: 'interjection', deltaSeconds: 500, note: '插话' });
  const budgetA = T.computeBudget(state, 'hall-a');
  const budgetB = T.computeBudget(state, 'hall-b');
  assert.equal(budgetA.bookedAdjustments, 500);
  assert.equal(budgetB.bookedAdjustments, 0);
  assert.equal(budgetB.capacity, 2400);
});

test('mergeThreeWay: 两边各改不同段落时自动合并，互不覆盖', () => {
  const base = baseState();
  const theirs = T.deepClone(base);
  theirs.rooms[0].capacitySeconds = 4200; // 对方改容量
  const ours = T.deepClone(base);
  ours.speechQueue.push(makeSpeech({ id: 's3', speaker: '丙', order: 2 })); // 本方加人
  const { state: merged, conflicts } = T.mergeThreeWay(base, theirs, ours);
  assert.equal(conflicts.length, 0);
  assert.equal(merged.rooms[0].capacitySeconds, 4200);
  assert.equal(merged.speechQueue.length, 3);
  assert.deepEqual(merged.speechQueue.map((s) => s.id), ['s1', 's2', 's3']);
});

test('mergeThreeWay: 两边改了同一段落（厅内容量）时进入冲突列表', () => {
  const base = baseState();
  const theirs = T.deepClone(base);
  theirs.rooms[0].capacitySeconds = 4200;
  const ours = T.deepClone(base);
  ours.rooms[0].capacitySeconds = 3000;
  const { conflicts } = T.mergeThreeWay(base, theirs, ours);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'room:hall-a:capacitySeconds');
  assert.equal(conflicts[0].theirs, 4200);
  assert.equal(conflicts[0].ours, 3000);
  assert.match(conflicts[0].label, /A厅/);
});

test('mergeThreeWay: 列表段落两边都新增时按 id 取并集（保留两份）', () => {
  const base = baseState();
  const theirs = T.deepClone(base);
  theirs.audits = [{ id: 'audit-theirs', at: '', roomId: 'hall-a', message: '对方窗口记录' }];
  const ours = T.deepClone(base);
  ours.audits = [{ id: 'audit-ours', at: '', roomId: 'hall-a', message: '本方窗口记录' }];
  const { state: merged, conflicts } = T.mergeThreeWay(base, theirs, ours);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'audits');
  assert.equal(merged.audits.length, 2);
  assert.deepEqual(merged.audits.map((a) => a.id).sort(), ['audit-ours', 'audit-theirs']);
});

test('mergeThreeWay: 后保存的版本不会盖掉先保存的插话加减', () => {
  const base = baseState();
  const theirs = T.deepClone(base);
  theirs.adjustments = [{ id: 'adj-theirs', roomId: 'hall-a', at: '', kind: 'interjection', deltaSeconds: 300, note: '对方窗口插话' }];
  const ours = T.deepClone(base);
  ours.adjustments = []; // 本方窗口加载早，没有这条插话
  const { state: merged } = T.mergeThreeWay(base, theirs, ours);
  assert.equal(merged.adjustments.length, 1);
  assert.equal(merged.adjustments[0].deltaSeconds, 300);
  assert.equal(T.computeBudget(merged, 'hall-a').bookedAdjustments, 300);
});
