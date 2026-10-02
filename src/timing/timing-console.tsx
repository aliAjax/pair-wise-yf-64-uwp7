import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import {
  commitChanges,
  recomputeHall,
  type Change,
  type ConferenceTimingState,
  type SaveResult,
  type TimelineSegment
} from './core';
import { getWindowId, loadTimingState, saveTimingState, type LoadResult } from './storage';

const KIND_LABEL: Record<string, string> = {
  add: '加入',
  remove: '移除',
  duration: '时长',
  reorder: '换位',
  interjection: '插话',
  'early-end': '提前结束',
  demote: '降级候补',
  promote: '候补递补',
  migrate: '数据升级',
  merge: '合并保存',
  conflict: '保存冲突'
};

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

/**
 * 按厅发言计时控制台：
 * 所有改动都通过 commitChanges 走内核（乐观锁 + 账本），每次保存后整厅时间线重算。
 */
export const TimingConsole = component$(() => {
  const loaded = useSignal<LoadResult | null>(null);
  const state = useStore<ConferenceTimingState>({ halls: {} });
  const activeHallId = useSignal('');
  const windowId = useSignal('server');
  const toasts = useSignal<Toast[]>([]);
  const migrationSeen = useSignal(false);

  const form = useStore({ label: '', delegation: '', plannedSeconds: 300, interjectionSeconds: 120 });
  const adjustSeconds = useSignal(60);
  const capacityInput = useSignal(0);

  useVisibleTask$(() => {
    const result = loadTimingState(localStorage);
    loaded.value = result;
    Object.assign(state, result.state);
    const firstId = Object.keys(state.halls)[0] ?? '';
    activeHallId.value = firstId;
    capacityInput.value = state.halls[firstId]?.capacitySeconds ?? 0;
    windowId.value = getWindowId();

    // 另一个标签页保存后，本窗口先同步到最新厅状态再继续操作（内核仍做版本校验兜底）
    window.addEventListener('storage', (event) => {
      if (event.key !== 'conference-timing-v2' || !event.newValue) return;
      try {
        const latest = JSON.parse(event.newValue) as ConferenceTimingState;
        Object.assign(state, latest);
      } catch {
        // 忽略无法解析的存储事件
      }
    });
  });

  // 持久化（内核保证账本只追加，刷新后版本水位仍可用于并发判断）
  const persist = $(() => {
    saveTimingState(localStorage, state);
  });

  const pushToast = $((ok: boolean, text: string) => {
    const id = Date.now() + Math.random();
    toasts.value = [...toasts.value, { id, ok, text }].slice(-4);
    setTimeout(() => {
      toasts.value = toasts.value.filter((toast) => toast.id !== id);
    }, 6000);
  });

  const hall = () => state.halls[activeHallId.value];
  const timeline = () => (hall() ? recomputeHall(JSON.parse(JSON.stringify(hall())), windowId.value) : null);

  /** 提交一批改动；落后版本时内核自动合并，段落冲突则拒绝并列出双方段落 */
  const submit = $(async (changes: Change[]): Promise<SaveResult | null> => {
    if (!activeHallId.value || changes.length === 0) return null;
    // 提交前再拉一次持久层最新版本（storage 事件可能尚未到达本窗口）
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('conference-timing-v2');
      if (raw) {
        try {
          const latest = JSON.parse(raw) as ConferenceTimingState;
          if (latest.halls[activeHallId.value]) Object.assign(state, latest);
        } catch {
          // 使用内存态继续
        }
      }
    }
    const current = state.halls[activeHallId.value];
    if (!current) return null;
    const result = commitChanges({
      conference: state as ConferenceTimingState,
      hallId: activeHallId.value,
      baseVersion: current.version,
      windowId: windowId.value,
      changes: changes.map((change) => ({ ...change, windowId: windowId.value }))
    });
    if (result.ok) {
      await persist();
      if (result.mergedFromOther?.length) {
        const detail = result.mergedFromOther
          .map((item) => `${item.windowId} 改了 ${item.segmentIds.length} 段`)
          .join('；');
        pushToast(true, `已合并先保存窗口的改动（${detail}），双方加减均保留`);
      }
    } else if (result.conflict) {
      pushToast(
        false,
        `保存被拒绝：本窗口改 ${result.conflict.currentWindow.segmentIds.length} 段，先保存窗口 ${result.conflict.otherWindow.windowId} 改 ${result.conflict.otherWindow.segmentIds.length} 段，段落重叠。请刷新后在新版本上修改。`
      );
    }
    return result;
  });

  const selectHall = $((id: string) => {
    activeHallId.value = id;
    capacityInput.value = state.halls[id]?.capacitySeconds ?? 0;
  });

  const addDelegate = $(async () => {
    if (form.label.trim().length < 2) {
      pushToast(false, '请输入代表姓名');
      return;
    }
    const result = await submit([
      { kind: 'addDelegate', windowId: windowId.value, label: form.label.trim(), delegation: form.delegation.trim(), plannedSeconds: Number(form.plannedSeconds) }
    ]);
    if (result?.ok) form.label = form.delegation = '';
  });

  const addInterjection = $(async () => {
    const result = await submit([
      {
        kind: 'addInterjection',
        windowId: windowId.value,
        label: `临时插话 ${new Date().toLocaleTimeString()}`,
        plannedSeconds: Number(form.interjectionSeconds),
        beforeOrder: 0
      }
    ]);
    if (result?.ok) pushToast(true, '临时插话已入账并插到队首，后续时段已重算');
  });

  const adjust = $(async (segment: TimelineSegment, delta: number) => {
    await submit([
      { kind: 'adjustDuration', windowId: windowId.value, segmentId: segment.id, deltaSeconds: delta, reason: delta < 0 ? '主持人压缩时长' : '申请延长' }
    ]);
  });

  const earlyEnd = $(async (segment: TimelineSegment) => {
    const planned = effectiveCalc(segment);
    const input = prompt(`「${segment.label}」实际发言多少秒？（计划 ${planned} 秒，少于计划的部分还回本厅）`, String(planned));
    if (input === null) return;
    const actual = Number(input);
    if (!Number.isFinite(actual) || actual < 0) {
      pushToast(false, '请输入有效的秒数');
      return;
    }
    await submit([{ kind: 'earlyEnd', windowId: windowId.value, segmentId: segment.id, actualSeconds: actual }]);
  });

  const move = $(async (segment: TimelineSegment, delta: -1 | 1) => {
    // 提交时以最新厅状态计算当前位置，避免连续点击时用旧索引
    const latest = state.halls[activeHallId.value];
    if (!latest) return;
    const fresh = recomputeHall(JSON.parse(JSON.stringify(latest)), windowId.value);
    const index = fresh.slots.findIndex((slot) => slot.segmentId === segment.id);
    const toOrder = index + delta;
    if (index < 0 || toOrder < 0 || toOrder >= fresh.slots.length) return;
    await submit([{ kind: 'reorder', windowId: windowId.value, segmentId: segment.id, toOrder }]);
  });

  const remove = $(async (segment: TimelineSegment) => {
    if (!confirm(`将「${segment.label}」移出本厅日程？`)) return;
    await submit([{ kind: 'remove', windowId: windowId.value, segmentId: segment.id }]);
  });

  const saveCapacity = $(async () => {
    const seconds = Number(capacityInput.value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      pushToast(false, '请输入有效的厅内容量秒数');
      return;
    }
    const result = await submit([
      { kind: 'setCapacity', windowId: windowId.value, plannedSeconds: seconds }
    ]);
    if (result?.ok) pushToast(true, `厅内容量已改为 ${seconds} 秒，时间线与候补已重算`);
  });

  const reload = $(() => {
    const result = loadTimingState(localStorage);
    Object.assign(state, result.state);
    pushToast(true, '已刷新到最新版本');
  });

  const currentHall = hall();
  const tl = timeline();
  const segmentById = (id: string) => currentHall?.segments.find((segment) => segment.id === id);

  return (
    <section class="panel" style="margin-top:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <h2 style="margin:0 0 4px">按厅发言计时</h2>
          <p style="margin:0;color:#59747b;font-size:13px">
            每次改动逐笔入账并重算后续时段 · 本窗口标识 <b>{windowId.value}</b>
          </p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          {Object.values(state.halls).map((item) => (
            <button
              key={item.id}
              class={item.id === activeHallId.value ? '' : 'secondary'}
              onClick$={() => selectHall(item.id)}
            >
              {item.name}
            </button>
          ))}
          <button class="secondary" onClick$={reload} title="从存储重新读取最新版本">
            ↻ 刷新最新版本
          </button>
        </div>
      </div>

      {!currentHall || !tl ? (
        <p style="color:#59747b">正在载入计时数据…</p>
      ) : (
        <>
          {loaded.value?.migrationMessages.length && !migrationSeen.value ? (
            <div style="margin-top:12px;padding:10px 12px;background:#f1f8f7;border:1px solid #bfe0dc;border-radius:10px;font-size:13px">
              {loaded.value.migrationMessages.map((message) => (
                <div key={message}>⬆ {message}</div>
              ))}
              <button class="secondary" style="margin-top:8px" onClick$={() => (migrationSeen.value = true)}>
                知道了
              </button>
            </div>
          ) : null}

          {/* 容量与剩余时间 */}
          <div
            style={{
              marginTop: '14px',
              padding: '14px',
              borderRadius: '12px',
              background: tl.overCapacity ? '#fdecea' : '#eff8f7',
              border: `1px solid ${tl.overCapacity ? '#f3b9b4' : '#bfe0dc'}`
            }}
          >
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
              <div>
                <div style="font-size:13px;color:#59747b">厅内容量 / 已排 / 剩余</div>
                <div style="font-size:20px;font-variant-numeric:'tabular-nums'">
                  <b>{formatClock(currentHall.capacitySeconds)}</b>
                  <span style="margin:0 8px;color:#9bb7b5">/</span>
                  {formatClock(tl.usedSeconds)}
                  <span style="margin:0 8px;color:#9bb7b5">/</span>
                  <b style={{ color: tl.overCapacity ? '#c2413b' : '#0d7772' }}>{formatClock(tl.freeSeconds)}</b>
                </div>
              </div>
              <div style="font-size:13px">
                <div>已提前结束还回厅里：<b>{currentHall.returnedSeconds}</b> 秒（留给后面的人）</div>
                <div>排队 {tl.scheduledCount} 人 · 候补 {tl.waitlisted.length} 人 · 版本 v{currentHall.version}</div>
                {tl.overCapacity ? <div style="color:#c2413b">⚠ 插话已超出容量 {tl.overflowSeconds} 秒</div> : null}
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <input
                  type="number"
                  style="width:110px"
                  value={capacityInput.value}
                  onInput$={(event) => (capacityInput.value = Number((event.target as HTMLInputElement).value))}
                />
                <span style="font-size:12px;color:#59747b">秒</span>
                <button class="secondary" onClick$={saveCapacity}>
                  改容量并重算
                </button>
              </div>
            </div>
            <div style="margin-top:10px;height:8px;border-radius:99px;background:#d9e9e7;overflow:hidden">
              <div
                style={{
                  width: `${Math.min(100, (tl.usedSeconds / currentHall.capacitySeconds) * 100)}%`,
                  height: '100%',
                  background: tl.overCapacity ? '#c2413b' : '#0d7772'
                }}
              />
            </div>
          </div>

          <div class="grid" style="margin-top:14px">
            {/* 时间线 */}
            <div>
              <h3 style="margin:'0 0 8px'">发言时间线（改动后自动重算）</h3>
              {tl.slots.length === 0 && <p style="color:#59747b">本厅暂无安排。</p>}
              {tl.slots.map((slot, index) => {
                const segment = segmentById(slot.segmentId)!;
                const effective =
                  segment.status === 'done' && segment.actualSeconds !== undefined
                    ? segment.actualSeconds
                    : slot.durationSeconds;
                return (
                  <div class="queue-row" key={slot.segmentId} style={slot.overflow ? 'outline:2px solid #f3b9b4' : ''}>
                    <strong>#{index + 1}</strong>
                    <div>
                      <b>
                        {segment.type === 'interjection' ? '⚡ ' : ''}
                        {segment.label}
                      </b>
                      <div style="color:#638087;font-size:12px">
                        {segment.delegation} · {formatClock(slot.startSeconds)}–{formatClock(slot.endSeconds)} · 计划{' '}
                        {segment.plannedSeconds} 秒
                        {segment.adjustments.length > 0 && (
                          <span style="color:#b4551f">
                            {' '}
                            （调整 {segment.adjustments.length} 笔，合计{' '}
                            {segment.adjustments.reduce((sum, item) => sum + item.deltaSeconds, 0) >= 0 ? '+' : ''}
                            {segment.adjustments.reduce((sum, item) => sum + item.deltaSeconds, 0)} 秒）
                          </span>
                        )}
                        {segment.status === 'done' && <span class="pill" style="margin-left:6px">已结束</span>}
                      </div>
                    </div>
                    <span class="pill">{formatClock(effective)}</span>
                    <div style="display:flex;gap:4px;flex-wrap:wrap">
                      <button class="secondary" title="前移" onClick$={() => move(segment, -1)} disabled={index === 0}>
                        ↑
                      </button>
                      <button
                        class="secondary"
                        title="后移"
                        onClick$={() => move(segment, 1)}
                        disabled={index === tl.slots.length - 1}
                      >
                        ↓
                      </button>
                      <button class="secondary" onClick$={() => adjust(segment, -Math.abs(adjustSeconds.value))}>
                        -{adjustSeconds.value}s
                      </button>
                      <button class="secondary" onClick$={() => adjust(segment, Math.abs(adjustSeconds.value))}>
                        +{adjustSeconds.value}s
                      </button>
                      <button class="secondary" onClick$={() => earlyEnd(segment)}>
                        提前结束
                      </button>
                      <button class="danger" onClick$={() => remove(segment)}>
                        删
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* 候补名单 */}
              {tl.waitlisted.length > 0 && (
                <div style="margin-top:14px;padding:12px;background:#fff7ed;border:1px solid #f3d6ad;border-radius:12px">
                  <h3 style="margin:'0 0 8px';color:#9a5b13">候补名单（容量空余时按 FIFO 自动递补）</h3>
                  {tl.waitlisted.map((segment) => (
                    <div key={segment.id} style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:14px">
                      <div>
                        <b>{segment.label}</b> <span style="color:#8a6a45;font-size:12px">{segment.delegation}</span>
                      </div>
                      <div style="font-size:13px;color:#9a5b13">
                        需 {segment.status === 'done' ? segment.actualSeconds : effectiveCalc(segment)} 秒 · 降级时差{' '}
                        {segment.demotedShortfall ?? '?'} 秒
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 操作侧栏 */}
            <aside>
              <h3 style="margin:'0 0 8px'">登记与操作</h3>
              <div style="display:grid;gap:8px">
                <input
                  placeholder="代表姓名"
                  value={form.label}
                  onInput$={(event) => (form.label = (event.target as HTMLInputElement).value)}
                />
                <input
                  placeholder="代表团"
                  value={form.delegation}
                  onInput$={(event) => (form.delegation = (event.target as HTMLInputElement).value)}
                />
                <div style="display:flex;gap:8px">
                  <input
                    type="number"
                    min={60}
                    placeholder="计划秒数"
                    value={form.plannedSeconds}
                    onInput$={(event) => (form.plannedSeconds = Number((event.target as HTMLInputElement).value))}
                  />
                  <button onClick$={addDelegate}>排到队尾</button>
                </div>
                <div style="display:flex;gap:8px;margin-top:6px">
                  <input
                    type="number"
                    min={30}
                    placeholder="插话秒数"
                    value={form.interjectionSeconds}
                    onInput$={(event) =>
                      (form.interjectionSeconds = Number((event.target as HTMLInputElement).value))
                    }
                  />
                  <button class="secondary" onClick$={addInterjection}>
                    临时插话入账
                  </button>
                </div>
                <label style="font-size:13px;color:#59747b;margin-top:8px">
                  快捷加减步长（秒）
                  <input
                    type="number"
                    style="margin-top:4px"
                    value={adjustSeconds.value}
                    onInput$={(event) => (adjustSeconds.value = Number((event.target as HTMLInputElement).value))}
                  />
                </label>
              </div>

              <h3 style="margin:'16px 0 8px'">改动账本（每次加减都累加，不覆盖）</h3>
              <div style="max-height:340px;overflow:auto;font-size:13px">
                {currentHall.ledger
                  .slice()
                  .reverse()
                  .slice(0, 30)
                  .map((entry) => (
                    <div key={entry.id} style="padding:8px 0;border-bottom:1px solid #e6efee">
                      <div style="display:flex;justify-content:space-between;gap:8px">
                        <span class="pill">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                        <small style="color:#7c969a">
                          {entry.windowId} · v{entry.version ?? '-'}
                        </small>
                      </div>
                      <div style="margin-top:3px">{entry.message}</div>
                    </div>
                  ))}
              </div>
            </aside>
          </div>

          {/* 合并 / 冲突提示 */}
          <div style="position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:50">
            {toasts.value.map((toast) => (
              <div
                key={toast.id}
                style={{
                  padding: '10px 14px',
                  borderRadius: '10px',
                  maxWidth: '380px',
                  fontSize: '13px',
                  color: toast.ok ? '#0b4f4b' : '#7a2722',
                  background: toast.ok ? '#dff3ef' : '#fdecea',
                  border: `1px solid ${toast.ok ? '#a9d9d3' : '#f1b5af'}`
                }}
              >
                {toast.text}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
});

/** 候补行展示当前生效时长（计划 + 累计调整，不小于 0） */
function effectiveCalc(segment: TimelineSegment): number {
  const delta = segment.adjustments.reduce((sum, item) => sum + item.deltaSeconds, 0);
  return Math.max(0, segment.plannedSeconds + delta);
}
