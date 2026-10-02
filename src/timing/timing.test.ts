import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createConference,
  recomputeHall,
  commitChanges,
  effectiveSeconds,
  occupiedSeconds,
  migrateV1,
  type ConferenceTimingState
} from './core';

const W1 = '窗口-甲';
const W2 = '窗口-乙';

/** 建一个 600 秒容量的厅，含三名代表：300 / 200 / 200 秒 */
function setup(): { conf: ConferenceTimingState; ids: string[] } {
  const conf = createConference([
    { id: 'hall-a', name: 'A厅', capacitySeconds: 600 },
    { id: 'hall-b', name: 'B厅', capacitySeconds: 300 }
  ]);
  const r = commitChanges({
    conference: conf,
    hallId: 'hall-a',
    baseVersion: 0,
    windowId: W1,
    changes: [
      { kind: 'addDelegate', windowId: W1, label: '甲代表', delegation: '甲国', plannedSeconds: 300 },
      { kind: 'addDelegate', windowId: W1, label: '乙代表', delegation: '乙国', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: W1, label: '丙代表', delegation: '丙国', plannedSeconds: 200 }
    ]
  });
  assert.equal(r.ok, true);
  const ids = r.timeline.slots.map((slot) => slot.segmentId);
  assert.equal(ids.length, 2); // 700 > 600，丙被降级
  return { conf, ids: [...ids, r.hall.segments.find((s) => s.label === '丙代表')!.id] };
}

test('超容量：排在最后的代表先降级为候补，并写明差多少秒', () => {
  const { conf, ids } = setup();
  const hall = conf.halls['hall-a'];
  const bing = hall.segments.find((s) => s.label === '丙代表')!;

  assert.equal(bing.status, 'waitlisted');
  assert.equal(bing.demotedShortfall, 100); // 300+200+200-600
  const demoteLedger = hall.ledger.find((e) => e.kind === 'demote')!;
  assert.match(demoteLedger.message, /差 100 秒/);

  // 甲、乙占满 500 秒，余 100 秒
  const tl = recomputeHall(JSON.parse(JSON.stringify(hall)), W1);
  assert.equal(tl.usedSeconds, 500);
  assert.equal(tl.freeSeconds, 100);
  assert.deepEqual(tl.slots.map((s) => s.segmentId), ids.slice(0, 2));
});

test('提前结束：空出的秒数还回厅里，候补按 FIFO 自动递补', () => {
  const { conf, ids } = setup();
  // 甲 300 秒只讲了 100 秒，提前结束 → 还回 200 秒 → 总需 100+200+200=500，丙可递补
  const r = commitChanges({
    conference: conf,
    hallId: 'hall-a',
    baseVersion: conf.halls['hall-a'].version,
    windowId: W1,
    changes: [{ kind: 'earlyEnd', windowId: W1, segmentId: ids[0], actualSeconds: 100 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.hall.returnedSeconds, 200);
  assert.equal(r.timeline.scheduledCount, 3);
  const bing = r.hall.segments.find((s) => s.label === '丙代表')!;
  assert.equal(bing.status, 'scheduled');
  assert.equal(bing.demotedShortfall, undefined);
  assert.equal(r.timeline.usedSeconds, 500);
  assert.equal(r.timeline.freeSeconds, 100);
  assert.match(r.hall.ledger.at(-1)?.message ?? '', /合并|递补|空出 200 秒/);
});

test('提前结束还回的时间不足以递补时，候补继续等待并保留差额记录', () => {
  const { conf, ids } = setup();
  const r = commitChanges({
    conference: conf,
    hallId: 'hall-a',
    baseVersion: conf.halls['hall-a'].version,
    windowId: W1,
    changes: [{ kind: 'earlyEnd', windowId: W1, segmentId: ids[0], actualSeconds: 250 }] // 只还 50 秒，丙需 200
  });
  assert.equal(r.ok, true);
  assert.equal(r.hall.returnedSeconds, 50);
  assert.equal(r.timeline.scheduledCount, 2);
  const bing = r.hall.segments.find((s) => s.label === '丙代表')!;
  assert.equal(bing.status, 'waitlisted');
});

test('时长每次改动累加，且后续时段全部重算', () => {
  const { conf, ids } = setup();
  const base = conf.halls['hall-a'].version;
  const jia = conf.halls['hall-a'].segments.find((s) => s.label === '甲代表')!;

  commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: base, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: jia.id, deltaSeconds: -60, reason: '压缩一分钟' }]
  });
  // 第二次调整从最新版本继续；甲生效 240，总 440，余 160 仍不够丙(200)
  const r2 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: conf.halls['hall-a'].version, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: jia.id, deltaSeconds: -60, reason: '再压缩一分钟' }]
  });
  assert.equal(r2.ok, true);
  assert.equal(effectiveSeconds(jia), 300); // 原对象未被克隆污染前的值（提交在克隆上生效）
  const updatedJia = r2.hall.segments.find((s) => s.id === jia.id)!;
  assert.equal(updatedJia.adjustments.length, 2);
  assert.equal(effectiveSeconds(updatedJia), 180);
  // 乙的开始时间应随甲缩短前移：原 300 → 240 → 180
  const yiSlot = r2.timeline.slots.find((s) => s.segmentId === ids[1])!;
  assert.equal(yiSlot.startSeconds, 180);

  // 再缩 50 → 余 210 时丙(200) 自动递补
  const r3 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: r2.hall.version, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: jia.id, deltaSeconds: -50, reason: '主持人压缩' }]
  });
  assert.equal(r3.timeline.scheduledCount, 3);
  assert.equal(r3.timeline.freeSeconds, 70); // 130+200+200 = 530
});

test('临时插话必须入账，占用厅容量并可把最后的代表挤成候补', () => {
  const conf = createConference([{ id: 'h', name: '厅', capacitySeconds: 600 }]);
  commitChanges({
    conference: conf, hallId: 'h', baseVersion: 0, windowId: W1,
    changes: [
      { kind: 'addDelegate', windowId: W1, label: 'A', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: W1, label: 'B', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: W1, label: 'C', plannedSeconds: 200 }
    ]
  });
  assert.equal(conf.halls['h'].segments.find((s) => s.label === 'C')!.status, 'scheduled');

  // 150 秒插话插到队首：350+200+200=750 → C 被挤掉，差 150
  const r = commitChanges({
    conference: conf, hallId: 'h', baseVersion: conf.halls['h'].version, windowId: W1,
    changes: [{ kind: 'addInterjection', windowId: W1, label: '主席紧急插话', plannedSeconds: 150, beforeOrder: 0 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.timeline.slots.length, 3);
  assert.equal(r.timeline.slots[0].segmentId, r.hall.segments.find((s) => s.label === '主席紧急插话')!.id);
  const c = r.hall.segments.find((s) => s.label === 'C')!;
  assert.equal(c.status, 'waitlisted');
  assert.equal(c.demotedShortfall, 150);
  assert.ok(r.hall.ledger.some((e) => e.kind === 'interjection'));
});

test('调整顺序后后续时段重算', () => {
  const conf = createConference([{ id: 'h', name: '厅', capacitySeconds: 1000 }]);
  const r0 = commitChanges({
    conference: conf, hallId: 'h', baseVersion: 0, windowId: W1,
    changes: [
      { kind: 'addDelegate', windowId: W1, label: 'A', plannedSeconds: 100 },
      { kind: 'addDelegate', windowId: W1, label: 'B', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: W1, label: 'C', plannedSeconds: 300 }
    ]
  });
  const ids = r0.timeline.slots.map((s) => s.segmentId);
  const r = commitChanges({
    conference: conf, hallId: 'h', baseVersion: r0.hall.version, windowId: W1,
    changes: [{ kind: 'reorder', windowId: W1, segmentId: ids[2], toOrder: 0 }]
  });
  assert.deepEqual(r.timeline.slots.map((s) => s.segmentId), [ids[2], ids[0], ids[1]]);
  assert.equal(r.timeline.slots[0].startSeconds, 0);
  assert.equal(r.timeline.slots[1].startSeconds, 300);
});

test('两窗口改不同段落：后保存的一份不覆盖先前加减，自动合并并列出双方段落', () => {
  const { conf, ids } = setup();
  const base = conf.halls['hall-a'].version;

  // 窗口甲先保存：甲 -10
  const r1 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: base, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: ids[0], deltaSeconds: -10 }]
  });
  assert.equal(r1.ok, true);

  // 窗口乙拿着旧版本保存：改的是乙代表（不同段落）→ 合并
  const r2 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: base, windowId: W2,
    changes: [{ kind: 'adjustDuration', windowId: W2, segmentId: ids[1], deltaSeconds: -20 }]
  });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.mergedFromOther?.[0]?.segmentIds, [ids[0]]);
  const jia = r2.hall.segments.find((s) => s.label === '甲代表')!;
  const yi = r2.hall.segments.find((s) => s.label === '乙代表')!;
  // 两笔加减都在，谁也没盖掉谁
  assert.deepEqual(jia.adjustments.map((a) => a.deltaSeconds), [-10]);
  assert.deepEqual(yi.adjustments.map((a) => a.deltaSeconds), [-20]);
  assert.ok(r2.hall.ledger.some((e) => e.kind === 'merge' && e.message.includes(W1) && e.message.includes(W2)));
});

test('两窗口改同一段落：拒绝后保存方，并列出各自改过的段落', () => {
  const { conf, ids } = setup();
  const base = conf.halls['hall-a'].version;

  commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: base, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: ids[0], deltaSeconds: -10 }]
  });
  const r2 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: base, windowId: W2,
    changes: [{ kind: 'adjustDuration', windowId: W2, segmentId: ids[0], deltaSeconds: -30 }]
  });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.conflict?.currentWindow.segmentIds, [ids[0]]);
  assert.deepEqual(r2.conflict?.otherWindow.segmentIds, [ids[0]]);
  // 被拒绝方的加减没有落库
  const jia = conf.halls['hall-a'].segments.find((s) => s.id === ids[0])!;
  assert.deepEqual(jia.adjustments.map((a) => a.deltaSeconds), [-10]);

  // 乙窗口刷新拿到新版本后改同一段 → 可以正常保存（冲突条目不挡路）
  const r3 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: conf.halls['hall-a'].version, windowId: W2,
    changes: [{ kind: 'adjustDuration', windowId: W2, segmentId: ids[0], deltaSeconds: -30 }]
  });
  assert.equal(r3.ok, true);
  assert.deepEqual(
    r3.hall.segments.find((s) => s.id === ids[0])!.adjustments.map((a) => a.deltaSeconds),
    [-10, -30]
  );
});

test('切换会议厅计时互不串账', () => {
  const { conf } = setup();
  // 在 B 厅加入内容并降级（B 容量 300）
  const rb = commitChanges({
    conference: conf, hallId: 'hall-b', baseVersion: 0, windowId: W1,
    changes: [
      { kind: 'addDelegate', windowId: W1, label: 'B厅-X', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: W1, label: 'B厅-Y', plannedSeconds: 200 }
    ]
  });
  assert.equal(rb.timeline.scheduledCount, 1);
  assert.equal(rb.hall.segments.find((s) => s.label === 'B厅-Y')!.status, 'waitlisted');

  // A 厅不受影响，B 厅的账本/版本也不进 A
  const a = conf.halls['hall-a'];
  const b = conf.halls['hall-b'];
  assert.ok(!a.segments.some((s) => s.label.startsWith('B厅-')));
  assert.ok(!b.ledger.some((e) => e.segmentIds.some((id) => a.segments.some((s) => s.id === id))));
  assert.equal(a.version >= 1, true);
  assert.equal(b.version, 1);

  // A 厅提前结束只还 A 厅
  const anyA = a.segments[0];
  const ra = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: a.version, windowId: W2,
    changes: [{ kind: 'earlyEnd', windowId: W2, segmentId: anyA.id, actualSeconds: 100 }]
  });
  assert.ok(ra.hall.returnedSeconds >= 0);
  assert.equal(conf.halls['hall-b'].returnedSeconds, 0);
});

test('旧数据升级：按原计划时长补齐，容量不足照常降级并写明差额', () => {
  const legacy = {
    rooms: [
      { id: 'r1', name: '一号厅' },
      { id: 'r2', name: '二号厅' }
    ],
    speechQueue: [
      { id: 'old-1', roomId: 'r1', speaker: '老甲', delegation: '甲国', plannedSeconds: 300, status: 'queued' },
      { id: 'old-2', roomId: 'r1', speaker: '老乙', delegation: '乙国', plannedSeconds: 300, status: 'queued' },
      { id: 'old-3', roomId: 'r2', speaker: '老丙', delegation: '丙国', plannedSeconds: 120, status: 'done' }
    ]
  };
  const conf = migrateV1(legacy, { capacitySeconds: { r1: 500 }, defaultCapacitySeconds: 3600 });

  const r1 = conf.halls['r1'];
  assert.equal(r1.schemaVersion, 2);
  assert.equal(r1.name, '一号厅');
  const old1 = r1.segments.find((s) => s.id === 'old-1')!;
  assert.equal(old1.plannedSeconds, 300);
  assert.equal(effectiveSeconds(old1), 300); // 按原计划补齐
  assert.equal(r1.segments.find((s) => s.id === 'old-2')!.status, 'waitlisted');
  assert.equal(r1.segments.find((s) => s.id === 'old-2')!.demotedShortfall, 100);
  assert.ok(r1.ledger.some((e) => e.kind === 'migrate' && e.message.includes('原计划时长')));

  // r2 用默认容量，不降级；顺序按旧队列保留
  const r2 = conf.halls['r2'];
  assert.equal(r2.capacitySeconds, 3600);
  assert.equal(r2.segments[0].id, 'old-3');

  // 升级后可以继续正常编辑（版本水位可用）
  const r = commitChanges({
    conference: conf, hallId: 'r1', baseVersion: r1.version, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: 'old-1', deltaSeconds: -100 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.timeline.scheduledCount, 2); // 200+300=500，老乙递补
});

test('插话本身把厅塞满时标记 overCapacity，而不是错误降级插话', () => {
  const conf = createConference([{ id: 'h', name: '厅', capacitySeconds: 300 }]);
  const r = commitChanges({
    conference: conf, hallId: 'h', baseVersion: 0, windowId: W1,
    changes: [{ kind: 'addInterjection', windowId: W1, label: '超长插话', plannedSeconds: 400 }]
  });
  assert.equal(r.timeline.overCapacity, true);
  assert.equal(r.timeline.overflowSeconds, 100);
  assert.equal(r.timeline.slots[0].overflow, true);
  assert.equal(r.timeline.waitlisted.length, 0);
});

test('候补自身时长改短后即使厅已排满也重新评估并递补', () => {
  const conf = createConference([{ id: 'h', name: '厅', capacitySeconds: 600 }]);
  const r0 = commitChanges({
    conference: conf, hallId: 'h', baseVersion: 0, windowId: W1,
    changes: [
      { kind: 'addDelegate', windowId: W1, label: 'A', plannedSeconds: 250 },
      { kind: 'addDelegate', windowId: W1, label: 'B', plannedSeconds: 250 },
      { kind: 'addDelegate', windowId: W1, label: 'C', plannedSeconds: 200 }
    ]
  });
  // 500 排满、余 100；C 需 200 → 候补
  assert.equal(r0.timeline.scheduledCount, 2);
  const c = r0.hall.segments.find((s) => s.label === 'C')!;
  assert.equal(c.status, 'waitlisted');

  const r = commitChanges({
    conference: conf, hallId: 'h', baseVersion: r0.hall.version, windowId: W2,
    changes: [{ kind: 'adjustDuration', windowId: W2, segmentId: c.id, deltaSeconds: -100 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.timeline.scheduledCount, 3);
  assert.equal(r.timeline.usedSeconds, 600);
});


test('容量调整也走版本通道：收紧后降级，放宽后递补', () => {
  const { conf, ids } = setup(); // 600 秒，甲300 乙200，丙候补
  const r = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: conf.halls['hall-a'].version, windowId: W1,
    changes: [{ kind: 'setCapacity', windowId: W1, plannedSeconds: 800 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.hall.capacitySeconds, 800);
  assert.equal(r.timeline.scheduledCount, 3);
  assert.deepEqual(r.timeline.slots.map((s) => s.segmentId), ids);

  const r2 = commitChanges({
    conference: conf, hallId: 'hall-a', baseVersion: r.hall.version, windowId: W1,
    changes: [{ kind: 'setCapacity', windowId: W1, plannedSeconds: 400 }]
  });
  assert.equal(r2.timeline.scheduledCount, 1);
  const bing = r2.hall.segments.find((s) => s.label === '丙代表')!;
  assert.equal(bing.status, 'waitlisted');
  assert.equal(bing.demotedShortfall, 300); // 300+200+200-400
});

test('occupiedSeconds：已结束段落按实际占用，未结束按计划+累加调整', () => {
  const conf = createConference([{ id: 'h', name: '厅', capacitySeconds: 9999 }]);
  const r0 = commitChanges({
    conference: conf, hallId: 'h', baseVersion: 0, windowId: W1,
    changes: [{ kind: 'addDelegate', windowId: W1, label: 'X', plannedSeconds: 300 }]
  });
  const id = r0.hall.segments[0].id;
  const r1 = commitChanges({
    conference: conf, hallId: 'h', baseVersion: r0.hall.version, windowId: W1,
    changes: [{ kind: 'adjustDuration', windowId: W1, segmentId: id, deltaSeconds: 60 }]
  });
  assert.equal(occupiedSeconds(r1.hall.segments[0]), 360);
  const r2 = commitChanges({
    conference: conf, hallId: 'h', baseVersion: r1.hall.version, windowId: W1,
    changes: [{ kind: 'earlyEnd', windowId: W1, segmentId: id, actualSeconds: 120 }]
  });
  assert.equal(occupiedSeconds(r2.hall.segments[0]), 120);
  // 账本完整保留了三类动作
  const kinds = r2.hall.ledger.map((e) => e.kind).filter((k) => k !== 'merge');
  for (const k of ['add', 'duration', 'early-end'] as const) assert.ok(kinds.includes(k));
});
