import test from 'node:test';
import assert from 'node:assert/strict';
import { commitChanges, type Change, type ConferenceTimingState } from './core';
import { LEGACY_STORAGE_KEY, TIMING_STORAGE_KEY, loadTimingState, saveTimingState } from './storage';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(key: string) { return this.map.get(key) ?? null; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string) { this.map.delete(key); }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

test('存储层：首次访问用演示数据并可持久化往返', () => {
  const storage = new MemoryStorage();
  const { state } = loadTimingState(storage);
  assert.ok(state.halls['hall-a']);
  saveTimingState(storage, state);
  assert.ok(storage.getItem(TIMING_STORAGE_KEY)?.includes('schemaVersion'));
  const again = loadTimingState(storage);
  assert.equal(again.state.halls['hall-a'].id, 'hall-a');
  assert.equal(again.migrationMessages.length, 0);
});

test('存储层：v1 旧数据自动升级，按原计划时长补齐', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEGACY_STORAGE_KEY,
    JSON.stringify({
      rooms: [{ id: 'r1', name: '旧一号厅' }],
      speechQueue: [
        { id: 's1', roomId: 'r1', speaker: '旧代表甲', delegation: '甲国', plannedSeconds: 600, status: 'queued' },
        { id: 's2', roomId: 'r1', speaker: '旧代表乙', delegation: '乙国', plannedSeconds: 600, status: 'queued' }
      ]
    })
  );
  const { state, migrationMessages } = loadTimingState(storage);
  assert.equal(migrationMessages.length, 1);
  assert.match(migrationMessages[0], /原计划时长/);
  const hall = state.halls['r1'];
  assert.equal(hall.capacitySeconds, 7200); // 装得下，不降级
  assert.equal(hall.segments.length, 2);
  assert.equal(hall.segments[0].plannedSeconds, 600);
});

test('端到端：两个"窗口"共享同一个存储，改不同段落自动合并不覆盖加减', () => {
  const storage = new MemoryStorage();

  // 初始化：A 厅 3 名代表
  let { state } = loadTimingState(storage);
  const hallId = 'hall-a';
  const init = commitChanges({
    conference: state, hallId, baseVersion: state.halls[hallId].version, windowId: '窗口-A',
    changes: [
      { kind: 'addDelegate', windowId: '窗口-A', label: '代表一', plannedSeconds: 200 },
      { kind: 'addDelegate', windowId: '窗口-A', label: '代表二', plannedSeconds: 200 }
    ]
  });
  assert.equal(init.ok, true);
  saveTimingState(storage, state);
  const baseVersion = state.halls[hallId].version;
  const [id1, id2] = init.hall.segments.map((s) => s.id);

  // 窗口 A 先保存
  {
    const { state: s1 } = loadTimingState(storage);
    const r = commitChanges({
      conference: s1, hallId, baseVersion, windowId: '窗口-A',
      changes: [{ kind: 'adjustDuration', windowId: '窗口-A', segmentId: id1, deltaSeconds: -30 }]
    });
    assert.equal(r.ok, true);
    saveTimingState(storage, s1);
  }

  // 窗口 B 拿着旧版本改另一段 → 自动合并
  {
    const { state: s2 } = loadTimingState(storage);
    const r = commitChanges({
      conference: s2, hallId, baseVersion, windowId: '窗口-B',
      changes: [{ kind: 'adjustDuration', windowId: '窗口-B', segmentId: id2, deltaSeconds: 45 }]
    });
    assert.equal(r.ok, true);
    assert.equal(r.mergedFromOther?.[0]?.windowId, '窗口-A');
    saveTimingState(storage, s2);
  }

  const finalState = loadTimingState(storage).state as ConferenceTimingState;
  const final = finalState.halls[hallId];
  assert.deepEqual(final.segments.find((s) => s.id === id1)!.adjustments.map((a) => a.deltaSeconds), [-30]);
  assert.deepEqual(final.segments.find((s) => s.id === id2)!.adjustments.map((a) => a.deltaSeconds), [45]);
  assert.ok(final.ledger.some((e) => e.kind === 'merge'));

  // 窗口 B 若仍旧版本改 id1（重叠）→ 拒绝
  const rejected = commitChanges({
    conference: JSON.parse(JSON.stringify(finalState)), hallId, baseVersion, windowId: '窗口-B',
    changes: [{ kind: 'adjustDuration', windowId: '窗口-B', segmentId: id1, deltaSeconds: -99 }]
  });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.conflict?.otherWindow.segmentIds, [id1]);
});

test('端到端：提前结束还时间 → 容量空出 → 候补递补（同一存储往返）', () => {
  const storage = new MemoryStorage();
  let { state } = loadTimingState(storage);
  const hallId = 'hall-b';
  state.halls[hallId].capacitySeconds = 300; // 收紧容量制造候补
  const r0 = commitChanges({
    conference: state, hallId, baseVersion: state.halls[hallId].version, windowId: 'w',
    changes: [
      { kind: 'addDelegate', windowId: 'w', label: '一号', plannedSeconds: 150 },
      { kind: 'addDelegate', windowId: 'w', label: '二号', plannedSeconds: 150 },
      { kind: 'addDelegate', windowId: 'w', label: '三号', plannedSeconds: 150 }
    ]
  });
  assert.equal(r0.timeline.scheduledCount, 2);
  saveTimingState(storage, state);

  const first = r0.timeline.slots[0].segmentId;
  const { state: reloaded } = loadTimingState(storage);
  const r1 = commitChanges({
    conference: reloaded, hallId, baseVersion: reloaded.halls[hallId].version, windowId: 'w',
    changes: [{ kind: 'earlyEnd', windowId: 'w', segmentId: first, actualSeconds: 30 }] // 还 120 秒，三号需 150
  });
  assert.equal(r1.timeline.scheduledCount, 2); // 还差一点
  assert.equal(r1.hall.returnedSeconds, 120);

  // 再缩短二号 30 秒 → 正好能装下三号
  const second = r1.timeline.slots[1].segmentId;
  const changes: Change[] = [{ kind: 'adjustDuration', windowId: 'w', segmentId: second, deltaSeconds: -30 }];
  const r2 = commitChanges({
    conference: reloaded, hallId, baseVersion: r1.hall.version, windowId: 'w', changes
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.timeline.scheduledCount, 3);
  assert.equal(r2.timeline.usedSeconds, 300);
  assert.equal(r2.timeline.freeSeconds, 0);
});
