import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  STORAGE_KEY,
  migrateState,
  computeBudget,
  recomputeHall,
  mergeThreeWay,
  diffParagraphs,
  summarizeValue,
  statusLabel,
  applyOne,
  mergeList,
  deepClone,
  LIST_KEYS,
  type ConferenceState,
  type Speech,
  type SpeechStatus,
  type Conflict,
  type Audit,
} from '~/lib/time';

const now = () => new Date().toISOString();

const seed: ConferenceState = {
  version: 2,
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6, capacitySeconds: 3600 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4, capacitySeconds: 2400 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now(), order: 0 },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now(), order: 1 },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now(), order: 0 }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now() }
  ],
  audits: [
    { id: 'audit-1', at: now(), roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续', paragraph: 'speech:speech-1:status' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位', paragraph: 'queue', deltaSeconds: 180 }
  ],
  adjustments: [
    { id: 'adj-1', roomId: 'hall-a', at: new Date(Date.now() - 90000).toISOString(), kind: 'interjection', deltaSeconds: 180, note: '临时插话申请' }
  ],
  lowLatency: false
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

function readRaw(): unknown | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function audit(roomId: string, message: string, paragraph?: string, deltaSeconds?: number): Audit {
  return { id: crypto.randomUUID(), at: now(), roomId, message, paragraph, deltaSeconds };
}

function namesOf(state: ConferenceState, ids: string[]): string {
  return ids
    .map((id) => state.speechQueue.find((speech) => speech.id === id)?.speaker)
    .filter(Boolean)
    .join('、');
}

function applyDuration(target: ConferenceState, speech: Speech, next: number, paragraph: string) {
  const before = speech.plannedSeconds;
  speech.plannedSeconds = Math.max(60, next);
  speech.remainingSeconds = speech.status === 'queued' ? speech.plannedSeconds : speech.remainingSeconds;
  speech.updatedAt = now();
  target.audits.unshift(audit(speech.roomId, `${speech.speaker} 发言时长 ${before} → ${speech.plannedSeconds} 秒（${speech.plannedSeconds - before >= 0 ? '+' : ''}${speech.plannedSeconds - before}）`, paragraph, speech.plannedSeconds - before));
  const overBefore = computeBudget(target, speech.roomId).overSeconds;
  const rec = recomputeHall(target, speech.roomId);
  if (rec.demoted.length) {
    target.audits.unshift(audit(speech.roomId, `时长调整后容量不足，${namesOf(target, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
  }
  if (rec.promoted.length) {
    target.audits.unshift(audit(speech.roomId, `时长调整后时间退回，${namesOf(target, rec.promoted)} 由候补补回`, 'queue'));
  }
}

const fmtRel = (seconds: number) =>
  `+${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(migrateState(readRaw() ?? seed));
  const conflicts = useSignal<Conflict[]>([]);
  const toast = useSignal('');
  const interjection = useSignal({ seconds: 120, note: '' });
  const manual = useSignal({ delta: 600, note: '' });

  // 本窗口已知的版本与基线快照，用于多窗口三路合并。
  let knownVersion = state.version;
  let baseSnapshot: ConferenceState = deepClone(state);

  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  const persist$ = $((target: ConferenceState) => {
    const raw = readRaw();
    const latest = raw ? migrateState(raw) : null;
    if (!latest || latest.version === knownVersion) {
      target.version = knownVersion + 1;
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
      knownVersion = target.version;
      baseSnapshot = deepClone(target);
      conflicts.value = [];
      return;
    }
    // 另一窗口已经保存过：三路合并，后保存的一份不覆盖先保存的加减。
    const { state: merged, conflicts: found } = mergeThreeWay(baseSnapshot, latest, target);
    Object.assign(target, merged);
    const rec = recomputeHall(target, target.activeRoomId);
    if (rec.demoted.length) {
      target.audits.unshift(audit(target.activeRoomId, `合并后重新排程：${namesOf(target, rec.demoted)} 降为候补（差 ${rec.overSeconds} 秒）`, 'queue'));
    }
    target.version = latest.version + 1;
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
    knownVersion = target.version;
    baseSnapshot = deepClone(target);
    conflicts.value = found;
  });

  // 监听其他窗口（标签页）的保存。
  useVisibleTask$(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      let incoming: ConferenceState;
      try {
        incoming = migrateState(JSON.parse(event.newValue));
      } catch {
        return;
      }
      if (incoming.version <= knownVersion) return;
      const localChanged = diffParagraphs(baseSnapshot, state).length > 0;
      if (!localChanged && conflicts.value.length === 0) {
        Object.assign(state, incoming);
        knownVersion = incoming.version;
        baseSnapshot = deepClone(incoming);
        toast.value = '另一窗口已更新计时，本厅数据已同步';
      } else {
        const { state: merged, conflicts: found } = mergeThreeWay(baseSnapshot, incoming, state);
        Object.assign(state, merged);
        const rec = recomputeHall(state, state.activeRoomId);
        state.version = incoming.version + 1;
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        knownVersion = state.version;
        baseSnapshot = deepClone(state);
        conflicts.value = found;
        if (rec.demoted.length) {
          state.audits.unshift(audit(state.activeRoomId, `合并后重新排程：${namesOf(state, rec.demoted)} 降为候补`, 'queue'));
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  useVisibleTask$(({ track }) => {
    track(() => toast.value);
    if (!toast.value) return;
    const timer = setTimeout(() => (toast.value = ''), 4000);
    return () => clearTimeout(timer);
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
  const budget = () => computeBudget(state, state.activeRoomId);

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    state.audits.unshift(audit(roomId, `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}，本厅计时独立计算、互不串账`));
    persist$(state);
  });

  const addSpeech$ = $((values: QueueForm) => {
    const roomId = state.activeRoomId;
    const order = state.speechQueue.filter((speech) => speech.roomId === roomId).length;
    state.speechQueue.push({
      id: crypto.randomUUID(),
      roomId,
      speaker: values.speaker,
      delegation: values.delegation,
      language: values.language,
      topic: values.topic,
      plannedSeconds: values.plannedSeconds,
      remainingSeconds: values.plannedSeconds,
      status: 'queued',
      updatedAt: now(),
      order
    });
    state.audits.unshift(audit(roomId, `${values.speaker} 已加入发言队列（计划 ${values.plannedSeconds} 秒）`, 'queue'));
    const overBefore = computeBudget(state, roomId).overSeconds;
    const rec = recomputeHall(state, roomId);
    if (rec.demoted.length) {
      state.audits.unshift(audit(roomId, `厅内容量不足，${namesOf(state, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
    }
    persist$(state);
  });

  const changeDuration$ = $((id: string, delta: number) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    applyDuration(state, speech, speech.plannedSeconds + delta, `speech:${id}:plannedSeconds`);
    persist$(state);
  });

  const setDuration$ = $((id: string, raw: number) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech || !raw) return;
    if (raw === speech.plannedSeconds) return;
    applyDuration(state, speech, raw, `speech:${id}:plannedSeconds`);
    persist$(state);
  });

  const moveSpeech$ = $((id: string, direction: -1 | 1) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    const siblings = state.speechQueue
      .filter((item) => item.roomId === speech.roomId)
      .sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((item) => item.id === id);
    const swap = siblings[index + direction];
    if (!swap) return;
    const tmp = speech.order;
    speech.order = swap.order;
    swap.order = tmp;
    state.audits.unshift(audit(speech.roomId, `${speech.speaker} 发言顺序调整为第 ${index + 1 + direction} 位`, 'queue'));
    const overBefore = computeBudget(state, speech.roomId).overSeconds;
    const rec = recomputeHall(state, speech.roomId);
    if (rec.demoted.length) {
      state.audits.unshift(audit(speech.roomId, `顺序调整后容量不足，${namesOf(state, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
    }
    persist$(state);
  });

  const addInterjection$ = $((seconds: number, note: string) => {
    const roomId = state.activeRoomId;
    const secs = Math.max(30, Math.round(seconds || 0));
    const reason = note.trim() || '临时插话';
    state.adjustments.push({ id: crypto.randomUUID(), roomId, at: now(), kind: 'interjection', deltaSeconds: secs, note: reason });
    state.audits.unshift(audit(roomId, `临时插话入账 +${secs} 秒：${reason}`, 'adjustments', secs));
    const overBefore = computeBudget(state, roomId).overSeconds;
    const rec = recomputeHall(state, roomId);
    if (rec.demoted.length) {
      state.audits.unshift(audit(roomId, `插话占用容量，${namesOf(state, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
    }
    persist$(state);
  });

  const addManualAdjustment$ = $((delta: number, note: string) => {
    const roomId = state.activeRoomId;
    const amount = Math.round(delta || 0);
    if (amount === 0) return;
    const reason = note.trim() || '厅内时间调剂';
    state.adjustments.push({ id: crypto.randomUUID(), roomId, at: now(), kind: 'manual', deltaSeconds: amount, note: reason });
    state.audits.unshift(audit(roomId, `厅内时间调剂 ${amount >= 0 ? '+' : ''}${amount} 秒：${reason}`, 'adjustments', amount));
    const overBefore = computeBudget(state, roomId).overSeconds;
    const rec = recomputeHall(state, roomId);
    if (rec.demoted.length) {
      state.audits.unshift(audit(roomId, `调剂后容量不足，${namesOf(state, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
    }
    if (rec.promoted.length) {
      state.audits.unshift(audit(roomId, `调剂追加时间，${namesOf(state, rec.promoted)} 由候补补回`, 'queue'));
    }
    persist$(state);
  });

  const startSpeech$ = $((id: string) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    state.speechQueue.forEach((item) => {
      if (item.roomId === speech.roomId && item.status === 'speaking') {
        item.status = 'done';
        item.updatedAt = now();
      }
    });
    speech.status = 'speaking';
    speech.updatedAt = now();
    state.audits.unshift(audit(speech.roomId, `${speech.speaker} 开始发言`, `speech:${id}:status`));
    const rec = recomputeHall(state, speech.roomId);
    if (rec.promoted.length) {
      state.audits.unshift(audit(speech.roomId, `上一位提前结束退回时间，${namesOf(state, rec.promoted)} 由候补补回`, 'queue'));
    }
    persist$(state);
  });

  const endSpeech$ = $((id: string) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    const returned = speech.remainingSeconds;
    speech.status = 'done';
    speech.updatedAt = now();
    state.audits.unshift(audit(speech.roomId, `${speech.speaker} 结束发言，剩余 ${returned} 秒退回厅内预算`, `speech:${id}:status`, -returned));
    const rec = recomputeHall(state, speech.roomId);
    if (rec.promoted.length) {
      state.audits.unshift(audit(speech.roomId, `提前结束空出 ${returned} 秒，${namesOf(state, rec.promoted)} 由候补补回`, 'queue'));
    }
    persist$(state);
  });

  const skipSpeech$ = $((id: string) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    speech.status = 'skipped';
    speech.updatedAt = now();
    state.audits.unshift(audit(speech.roomId, `${speech.speaker} 跳过发言`, `speech:${id}:status`));
    const rec = recomputeHall(state, speech.roomId);
    if (rec.promoted.length) {
      state.audits.unshift(audit(speech.roomId, `跳过空出时间，${namesOf(state, rec.promoted)} 由候补补回`, 'queue'));
    }
    persist$(state);
  });

  const tickSpeech$ = $((id: string, delta: number) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    speech.remainingSeconds = Math.max(0, speech.remainingSeconds + delta);
    speech.updatedAt = now();
    persist$(state);
  });

  const changeCapacity$ = $((roomId: string, raw: number) => {
    const room = state.rooms.find((item) => item.id === roomId);
    if (!room || !raw) return;
    const next = Math.max(600, Math.round(raw));
    if (next === room.capacitySeconds) return;
    const before = room.capacitySeconds;
    room.capacitySeconds = next;
    state.audits.unshift(audit(roomId, `${room.name} 厅内容量 ${before} → ${next} 秒`, `room:${roomId}:capacity`, next - before));
    const overBefore = computeBudget(state, roomId).overSeconds;
    const rec = recomputeHall(state, roomId);
    if (rec.demoted.length) {
      state.audits.unshift(audit(roomId, `容量调减后，${namesOf(state, rec.demoted)} 降为候补（差 ${overBefore} 秒）`, 'queue'));
    }
    if (rec.promoted.length) {
      state.audits.unshift(audit(roomId, `容量调增后，${namesOf(state, rec.promoted)} 由候补补回`, 'queue'));
    }
    persist$(state);
  });

  const resolveConflict$ = $((conflict: Conflict, resolution: 'ours' | 'theirs' | 'both') => {
    const target = conflicts.value.find((item) => item.key === conflict.key);
    if (!target) return;
    if (resolution === 'both' && LIST_KEYS.has(target.key)) {
      applyOne(state, target.key, mergeList(target.base, target.theirs, target.ours, target.key));
    } else {
      applyOne(state, target.key, resolution === 'ours' ? target.ours : target.theirs);
    }
    conflicts.value = conflicts.value.filter((item) => item.key !== target.key);
    state.audits.unshift(audit(state.activeRoomId, `冲突已处理：${target.label} → ${resolution === 'ours' ? '采用本窗口' : resolution === 'theirs' ? '采用对方窗口' : '保留两份'}`, target.key));
    persist$(state);
  });

  const handoff$ = $((channelId: string) => {
    state.channels = state.channels.map((channel) => channel.id === channelId ? { ...channel, status: 'handoff' } : channel);
    state.audits.unshift(audit(state.activeRoomId, `${channelId} 启动译员交接，原译文版本已冻结`, 'channels'));
    persist$(state);
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    state.channels = state.channels.map((channel) => channel.id === channelId ? { ...channel, interpreter, status: 'active', health: Math.min(100, channel.health + 2) } : channel);
    state.audits.unshift(audit(state.activeRoomId, `${interpreter} 接续 ${channelId}，后续字幕归属新译员`, 'channels'));
    persist$(state);
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) return;
    const channel = state.channels.find((item) => item.roomId === speech.roomId && item.language === '中文');
    if (!channel || !values.text.trim()) return;
    const existing = state.captions.find((item) => item.speechId === speech.id && item.language === channel.language);
    if (existing) {
      state.captions = state.captions.map((item) => item.id === existing.id ? { ...item, text: values.text, revision: item.revision + 1, interpreter: channel.interpreter, at: now() } : item);
    } else {
      state.captions.unshift({ id: crypto.randomUUID(), speechId: speech.id, roomId: speech.roomId, language: channel.language, interpreter: channel.interpreter, text: values.text, revision: 1, at: now() });
    }
    persist$(state);
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift(audit(state.activeRoomId, `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}`, 'terms'));
    persist$(state);
  });

  const addSpeechWrapped$ = $((values: QueueForm) => addSpeech$(values));
  const publishCaptionWrapped$ = $((values: z.infer<typeof captionSchema>) => publishCaption$(values));

  const budgetView = budget();

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      {toast.value && <div class="toast">{toast.value}</div>}

      {conflicts.value.length > 0 && (
        <section class="conflict-banner">
          <h3>另一窗口与本窗口修改了同一个会议厅</h3>
          <p>后保存的版本没有覆盖先保存的加减；以下段落两边都有改动，请逐段选择采用哪一份：</p>
          {conflicts.value.map((conflict) => (
            <div class="conflict-row" key={conflict.key}>
              <div class="conflict-label"><b>{conflict.label}</b></div>
              <div class="conflict-side">对方窗口（先保存）：{summarizeValue(conflict.key, conflict.theirs)}</div>
              <div class="conflict-side">本窗口（后保存）：{summarizeValue(conflict.key, conflict.ours)}</div>
              <div class="conflict-actions">
                <button class="secondary" onClick$={() => resolveConflict$(conflict, 'theirs')}>采用对方</button>
                <button onClick$={() => resolveConflict$(conflict, 'ours')}>采用本方</button>
                {LIST_KEYS.has(conflict.key) && <button class="secondary" onClick$={() => resolveConflict$(conflict, 'both')}>保留两份</button>}
              </div>
            </div>
          ))}
        </section>
      )}

      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}
          </select>
          <label class="cap-edit">
            厅容量(秒)
            <input type="number" step={300} min={600} value={activeRoom().capacitySeconds}
              onChange$={(event) => changeCapacity$(state.activeRoomId, Number((event.target as HTMLInputElement).value))} />
          </label>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="budget-panel">
        <div class="budget-head">
          <b>厅内容量 {budgetView.capacity} 秒</b>
          <span>已用 {budgetView.used} 秒（入账 {budgetView.bookedAdjustments >= 0 ? '+' : ''}{budgetView.bookedAdjustments}）</span>
          <span>剩余 {budgetView.remaining} 秒</span>
          {budgetView.returnedSeconds > 0 && <span class="returned">提前结束退回 {budgetView.returnedSeconds} 秒</span>}
        </div>
        <Progress.Root value={Math.min(budgetView.used, budgetView.capacity)} max={budgetView.capacity} />
        {budgetView.overSeconds > 0 && <div class="over-note">超出厅内容量 {budgetView.overSeconds} 秒：已把排在最后的代表降级为候补，空出时间后按顺序补回</div>}
      </section>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列与计时</h2>
            <span class="pill">{budgetView.rows.length} 人发言中 · {budgetView.alternates.length} 人候补 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {budgetView.rows.length === 0 && <p>本厅暂无发言安排。</p>}
          {budgetView.rows.map(({ speech, start, end }) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{speech.order + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div class="decorative" style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div>
              </div>
              <div style="font-size:13px">
                <div>{fmtRel(start)} – {fmtRel(end)}</div>
                <div class="decorative" style="color:#638087">
                  {speech.status === 'speaking' ? `进行中 · 剩余 ${speech.remainingSeconds}s` : `计划 ${speech.plannedSeconds}s`}
                </div>
              </div>
              <span class="pill">{statusLabel(speech.status)}</span>
              <div class="row-actions">
                {speech.status === 'queued' && <>
                  <button class="secondary" onClick$={() => moveSpeech$(speech.id, -1)}>上移</button>
                  <button class="secondary" onClick$={() => moveSpeech$(speech.id, 1)}>下移</button>
                  <button class="secondary" onClick$={() => changeDuration$(speech.id, -60)}>-1分钟</button>
                  <button class="secondary" onClick$={() => changeDuration$(speech.id, 60)}>+1分钟</button>
                  <button onClick$={() => startSpeech$(speech.id)}>开始</button>
                  <button class="danger" onClick$={() => skipSpeech$(speech.id)}>跳过</button>
                </>}
                {speech.status === 'speaking' && <>
                  <button class="secondary" onClick$={() => tickSpeech$(speech.id, -60)}>手记-1分钟</button>
                  <button onClick$={() => endSpeech$(speech.id)}>结束并退回时间</button>
                </>}
              </div>
            </div>
          ))}

          {budgetView.alternates.length > 0 && (
            <div class="alternate-block">
              <h3>候补（超出容量时排在最后的代表自动降级）</h3>
              {budgetView.alternates.map((speech) => (
                <div class="queue-row alternate" key={speech.id}>
                  <strong>候补</strong>
                  <div>
                    <b>{speech.speaker}</b>
                    <div class="decorative" style="color:#638087;font-size:13px">{speech.delegation} · {speech.topic}</div>
                  </div>
                  <div style="font-size:13px">需 {speech.plannedSeconds}s</div>
                  <span class="pill alternate">候补</span>
                  <div class="row-actions">
                    <button class="secondary" onClick$={() => moveSpeech$(speech.id, -1)}>前移</button>
                    <button class="danger" onClick$={() => skipSpeech$(speech.id)}>跳过</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <h3 style="margin-top:18px">临时插话 / 厅内时间调剂（按次累加，触发后续时段重算）</h3>
          <div class="inline-form">
            <input type="number" min={30} step={30} value={interjection.value.seconds}
              onInput$={(event) => (interjection.value.seconds = Number((event.target as HTMLInputElement).value))} />
            <input style="flex:2;min-width:180px" value={interjection.value.note}
              onInput$={(event) => (interjection.value.note = (event.target as HTMLInputElement).value)} placeholder="插话事由，如：临时动议" />
            <button onClick$={() => { addInterjection$(interjection.value.seconds, interjection.value.note); interjection.value.note = ''; }}>插话入账</button>
          </div>
          <div class="inline-form">
            <input type="number" step={60} value={manual.value.delta}
              onInput$={(event) => (manual.value.delta = Number((event.target as HTMLInputElement).value))} />
            <input style="flex:2;min-width:180px" value={manual.value.note}
              onInput$={(event) => (manual.value.note = (event.target as HTMLInputElement).value)} placeholder="调剂说明（正数追加、负数收回）" />
            <button class="secondary" onClick$={() => { addManualAdjustment$(manual.value.delta, manual.value.note); manual.value.note = ''; }}>调剂入账</button>
          </div>

          <h3 style="margin-top:18px">新增代表</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px">
            <QueueForm onSubmit$={addSpeechWrapped$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
              <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
              <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}</div>
            </div>
          ))}
          <h3>实时字幕修正</h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaptionWrapped$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}><b>{caption.interpreter} · v{caption.revision}</b><p>{caption.text}</p></div>)}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>加减入账记录（本厅累计 {budgetView.bookedAdjustments >= 0 ? '+' : ''}{budgetView.bookedAdjustments} 秒）</h2>
          {state.adjustments.filter((item) => item.roomId === state.activeRoomId).length === 0 && <p>暂无插话或调剂入账。</p>}
          {state.adjustments.filter((item) => item.roomId === state.activeRoomId).map((item) => (
            <div class="queue-row" key={item.id}>
              <span />
              <div>
                <b>{item.kind === 'interjection' ? '临时插话' : '厅内调剂'}</b>
                <div style="color:#638087;font-size:13px">{item.note}</div>
              </div>
              <span class="pill">{new Date(item.at).toLocaleTimeString()}</span>
              <div class={item.deltaSeconds >= 0 ? 'delta-in' : 'delta-out'}>{item.deltaSeconds >= 0 ? '+' : ''}{item.deltaSeconds}s</div>
            </div>
          ))}
        </article>
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span /><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
      </section>

      <section class="panel" style="margin-top:18px">
        <h2>操作与交接时间线</h2>
        {state.audits.filter((auditItem) => auditItem.roomId === state.activeRoomId).slice(0, 12).map((auditItem) => (
          <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={auditItem.id}>
            <small>{new Date(auditItem.at).toLocaleTimeString()}{auditItem.deltaSeconds ? ` · ${auditItem.deltaSeconds >= 0 ? '+' : ''}${auditItem.deltaSeconds}s` : ''}</small>
            <div>{auditItem.message}</div>
          </div>
        ))}
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '按会议厅分别记账的发言计时：容量重算、候补降级、插话累加与多窗口冲突合并' }]
};
