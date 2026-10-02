// 纯逻辑层：会议厅发言计时、容量重算、旧数据升级、多窗口三路合并。
// 不依赖 Qwik，可单独在 node 中测试。

export const CURRENT_VERSION = 2;
export const STORAGE_KEY = 'conference-interpretation-v2';

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped' | 'alternate';
export type InterpreterStatus = 'active' | 'handoff' | 'standby';
export type AdjustmentKind = 'interjection' | 'manual';

export type Room = {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
  capacitySeconds: number;
};

export type Speech = {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
  order: number;
};

export type Channel = {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
};

export type Term = {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
};

export type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  at: string;
};

export type Audit = {
  id: string;
  at: string;
  roomId: string;
  message: string;
  paragraph?: string;
  deltaSeconds?: number;
};

export type Adjustment = {
  id: string;
  roomId: string;
  at: string;
  kind: AdjustmentKind;
  deltaSeconds: number;
  note: string;
};

export interface ConferenceState {
  version: number;
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  adjustments: Adjustment[];
  lowLatency: boolean;
}

export type ScheduleRow = {
  speech: Speech;
  order: number;
  start: number;
  end: number;
  effectiveSeconds: number;
};

export type HallBudget = {
  capacity: number;
  used: number;
  remaining: number;
  overSeconds: number;
  rows: ScheduleRow[];
  alternates: Speech[];
  skipped: Speech[];
  returnedSeconds: number;
  bookedAdjustments: number;
};

export type RecomputeResult = {
  demoted: string[];
  promoted: string[];
  overSeconds: number;
};

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中',
    speaking: '发言中',
    done: '已完成',
    skipped: '已跳过',
    alternate: '候补',
  };
  return labels[status] ?? status;
}

/** 按会议厅取出发言，按 order 排序（互不串账）。 */
export function roomSpeeches(state: ConferenceState, roomId: string): Speech[] {
  return state.speechQueue
    .filter((speech) => speech.roomId === roomId)
    .sort((a, b) => a.order - b.order);
}

function defaultCapacityFor(room: Partial<Room>, speeches: Speech[]): number {
  const planned = speeches
    .filter((speech) => speech.roomId === room.id)
    .reduce((sum, speech) => sum + (speech.plannedSeconds || 0), 0);
  // 升级时按原计划时长补齐：容量至少 1 小时，且能装下原有全部计划时长（向上取整到 5 分钟）。
  return Math.max(3600, Math.ceil(planned / 300) * 300);
}

/** 旧版本数据升级：补齐 order、remainingSeconds、capacitySeconds、adjustments、version。 */
export function migrateState(raw: unknown): ConferenceState {
  const legacy = (raw ?? {}) as Record<string, unknown>;
  const legacySpeeches = ((legacy.speechQueue as Speech[] | undefined) ?? []).map((speech, index) => ({
    ...speech,
    order: speech.order ?? index,
    remainingSeconds: speech.remainingSeconds ?? speech.plannedSeconds ?? 0,
    status: speech.status ?? 'queued',
  }));
  const rooms = ((legacy.rooms as Room[] | undefined) ?? []).map((room) => ({
    ...room,
    capacitySeconds: room.capacitySeconds ?? defaultCapacityFor(room, legacySpeeches),
  }));
  return {
    version: CURRENT_VERSION,
    rooms,
    activeRoomId: (legacy.activeRoomId as string) ?? rooms[0]?.id ?? '',
    speechQueue: legacySpeeches,
    channels: (legacy.channels as Channel[] | undefined) ?? [],
    terms: (legacy.terms as Term[] | undefined) ?? [],
    captions: (legacy.captions as Caption[] | undefined) ?? [],
    audits: (legacy.audits as Audit[] | undefined) ?? [],
    adjustments: (legacy.adjustments as Adjustment[] | undefined) ?? [],
    lowLatency: (legacy.lowLatency as boolean | undefined) ?? false,
  };
}

/** 计算某厅的时间预算：已用、剩余、超出秒数，以及后续时段的预计起止。 */
export function computeBudget(state: ConferenceState, roomId: string): HallBudget {
  const room = state.rooms.find((item) => item.id === roomId);
  const capacity = room?.capacitySeconds ?? 0;
  const speeches = roomSpeeches(state, roomId);
  const adjustments = state.adjustments.filter((item) => item.roomId === roomId);
  const bookedAdjustments = adjustments.reduce((sum, item) => sum + item.deltaSeconds, 0);

  let cursor = 0;
  let used = 0;
  let returnedSeconds = 0;
  const rows: ScheduleRow[] = [];
  const alternates: Speech[] = [];
  const skipped: Speech[] = [];

  for (const speech of speeches) {
    if (speech.status === 'skipped') {
      skipped.push(speech);
      continue;
    }
    if (speech.status === 'alternate') {
      alternates.push(speech);
      continue;
    }
    let effective = 0;
    if (speech.status === 'done') {
      // 提前结束：没用完的时间退回厅里。
      effective = Math.max(0, speech.plannedSeconds - speech.remainingSeconds);
      returnedSeconds += Math.max(0, speech.remainingSeconds);
    } else if (speech.status === 'speaking') {
      effective = Math.max(0, speech.plannedSeconds - speech.remainingSeconds);
    } else {
      effective = speech.plannedSeconds;
    }
    used += effective;
    if (speech.status === 'queued' || speech.status === 'speaking') {
      rows.push({
        speech,
        order: speech.order,
        start: cursor,
        end: cursor + speech.plannedSeconds,
        effectiveSeconds: effective,
      });
      cursor += speech.plannedSeconds;
    }
  }
  used += bookedAdjustments;

  return {
    capacity,
    used,
    remaining: capacity - used,
    overSeconds: Math.max(0, used - capacity),
    rows,
    alternates,
    skipped,
    returnedSeconds,
    bookedAdjustments,
  };
}

/**
 * 任一处修改后重算该厅：
 * - 超出容量时把排在最后的排队代表降级为候补（先差多少秒记在审计里）；
 * - 提前结束 / 调减时长 / 追加容量空出的时间，按顺序把候补补回队列。
 */
export function recomputeHall(state: ConferenceState, roomId: string): RecomputeResult {
  const demoted: string[] = [];
  const promoted: string[] = [];

  let budget = computeBudget(state, roomId);
  while (budget.overSeconds > 0) {
    const lastQueued = roomSpeeches(state, roomId)
      .reverse()
      .find((speech) => speech.status === 'queued');
    if (!lastQueued) break;
    lastQueued.status = 'alternate';
    demoted.push(lastQueued.id);
    budget = computeBudget(state, roomId);
  }

  budget = computeBudget(state, roomId);
  let guard = 0;
  while (guard < 100) {
    guard += 1;
    const firstAlternate = roomSpeeches(state, roomId).find((speech) => speech.status === 'alternate');
    if (!firstAlternate) break;
    if (budget.used + firstAlternate.plannedSeconds <= budget.capacity) {
      firstAlternate.status = 'queued';
      promoted.push(firstAlternate.id);
      budget = computeBudget(state, roomId);
    } else {
      break;
    }
  }

  return { demoted, promoted, overSeconds: budget.overSeconds };
}

// ---------- 多窗口（多标签页）并发修改的三路合并 ----------

export type Paragraphs = Record<string, unknown>;

export const LIST_KEYS = new Set(['queue', 'adjustments', 'audits', 'channels', 'terms', 'captions']);

export type Conflict = {
  key: string;
  label: string;
  base: unknown;
  theirs: unknown;
  ours: unknown;
  resolution?: 'ours' | 'theirs' | 'both';
};

/** 把状态拆成一个个“段落”，段落是合并与冲突提示的最小单位。 */
export function paragraphsOf(state: ConferenceState): Paragraphs {
  const paragraphs: Paragraphs = {};
  for (const room of state.rooms) {
    paragraphs[`room:${room.id}:capacitySeconds`] = room.capacitySeconds;
    paragraphs[`room:${room.id}:name`] = room.name;
    paragraphs[`room:${room.id}:topic`] = room.topic;
    paragraphs[`room:${room.id}:simultaneousChannels`] = room.simultaneousChannels;
  }
  for (const speech of state.speechQueue) {
    paragraphs[`speech:${speech.id}:status`] = speech.status;
    paragraphs[`speech:${speech.id}:plannedSeconds`] = speech.plannedSeconds;
    paragraphs[`speech:${speech.id}:remainingSeconds`] = speech.remainingSeconds;
    paragraphs[`speech:${speech.id}:order`] = speech.order;
    paragraphs[`speech:${speech.id}:roomId`] = speech.roomId;
    paragraphs[`speech:${speech.id}:speaker`] = speech.speaker;
    paragraphs[`speech:${speech.id}:delegation`] = speech.delegation;
    paragraphs[`speech:${speech.id}:language`] = speech.language;
    paragraphs[`speech:${speech.id}:topic`] = speech.topic;
  }
  paragraphs.queue = state.speechQueue.map((speech) => speech.id);
  paragraphs.adjustments = state.adjustments;
  paragraphs.audits = state.audits;
  paragraphs.channels = state.channels;
  paragraphs.terms = state.terms;
  paragraphs.captions = state.captions;
  paragraphs.activeRoomId = state.activeRoomId;
  paragraphs.lowLatency = state.lowLatency;
  return paragraphs;
}

function equalParagraph(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export type ParagraphDiff = { key: string; before: unknown; after: unknown };

export function diffParagraphs(base: ConferenceState, current: ConferenceState): ParagraphDiff[] {
  const before = paragraphsOf(base);
  const after = paragraphsOf(current);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: ParagraphDiff[] = [];
  for (const key of keys) {
    if (!equalParagraph(before[key], after[key])) {
      diffs.push({ key, before: before[key], after: after[key] });
    }
  }
  return diffs;
}

/** 列表段落合并：按 id 取并集，顺序以对方为准、本方新增的 id 补在末尾；queue 是 id 数组。 */
export function mergeList(base: unknown, theirs: unknown, ours: unknown, key: string): unknown {
  if (key === 'queue') {
    const theirIds = theirs as string[];
    const ourIds = ours as string[];
    return [...theirIds, ...ourIds.filter((id) => !theirIds.includes(id))];
  }
  const theirItems = (Array.isArray(theirs) ? theirs : []) as { id: string }[];
  const ourItems = (Array.isArray(ours) ? ours : []) as { id: string }[];
  const seen = new Set<string>();
  const merged: { id: string }[] = [];
  for (const item of [...theirItems, ...ourItems]) {
    if (item.id && !seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

/** 把一个段落写回状态。 */
export function applyOne(state: ConferenceState, key: string, value: unknown): void {
  if (key === 'queue') {
    const ids = value as string[];
    const byId = new Map(state.speechQueue.map((speech) => [speech.id, speech]));
    const reordered: Speech[] = [];
    ids.forEach((id, index) => {
      const speech = byId.get(id);
      if (speech) reordered.push({ ...speech, order: index });
    });
    const listed = new Set(ids);
    for (const speech of state.speechQueue) {
      if (!listed.has(speech.id)) reordered.push(speech);
    }
    state.speechQueue = reordered;
    return;
  }
  if (key === 'adjustments') {
    state.adjustments = value as Adjustment[];
    return;
  }
  if (key === 'audits') {
    state.audits = value as Audit[];
    return;
  }
  if (key === 'channels') {
    state.channels = value as Channel[];
    return;
  }
  if (key === 'terms') {
    state.terms = value as Term[];
    return;
  }
  if (key === 'captions') {
    state.captions = value as Caption[];
    return;
  }
  if (key === 'activeRoomId') {
    state.activeRoomId = value as string;
    return;
  }
  if (key === 'lowLatency') {
    state.lowLatency = value as boolean;
    return;
  }
  const match = key.match(/^(room|speech):([^:]+):(.+)$/);
  if (!match) return;
  const [, kind, id, field] = match;
  if (kind === 'room') {
    const room = state.rooms.find((item) => item.id === id);
    if (room) (room as unknown as Record<string, unknown>)[field] = value;
  } else {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (speech) (speech as unknown as Record<string, unknown>)[field] = value;
  }
}

/**
 * 三路合并：base 是双方共同的基线，theirs 是后保存的窗口，ours 是本窗口。
 * 只被一方改过的段落直接采用；两边都改过的段落进入冲突列表（列表默认并集，标注重复项），
 * 由用户在界面上逐段选择采用哪一份——后保存的一方永远不会盖掉先保存一方的加减。
 */
export function mergeThreeWay(
  base: ConferenceState,
  theirs: ConferenceState,
  ours: ConferenceState,
): { state: ConferenceState; conflicts: Conflict[] } {
  const baseParagraphs = paragraphsOf(base);
  const theirParagraphs = paragraphsOf(theirs);
  const ourParagraphs = paragraphsOf(ours);
  const keys = new Set([
    ...Object.keys(baseParagraphs),
    ...Object.keys(theirParagraphs),
    ...Object.keys(ourParagraphs),
  ]);

  const mergedParagraphs: Paragraphs = {};
  const conflicts: Conflict[] = [];

  for (const key of keys) {
    const baseValue = baseParagraphs[key] ?? null;
    const theirValue = theirParagraphs[key] ?? null;
    const ourValue = ourParagraphs[key] ?? null;
    const theirChanged = !equalParagraph(baseValue, theirValue);
    const ourChanged = !equalParagraph(baseValue, ourValue);

    if (theirChanged && ourChanged) {
      conflicts.push({
        key,
        label: paragraphLabel(key, ours),
        base: baseValue,
        theirs: theirValue,
        ours: ourValue,
      });
      mergedParagraphs[key] = LIST_KEYS.has(key)
        ? mergeList(baseValue, theirValue, ourValue, key)
        : theirValue;
    } else if (theirChanged) {
      mergedParagraphs[key] = theirValue;
    } else if (ourChanged) {
      mergedParagraphs[key] = ourValue;
    } else {
      mergedParagraphs[key] = baseValue;
    }
  }

  const merged = deepClone(ours);
  // 补齐任一方新增的发言人：字段段落只能改已有对象，新 id 需要先进入数组。
  const knownSpeechIds = new Set(merged.speechQueue.map((speech) => speech.id));
  for (const speech of [...theirs.speechQueue, ...base.speechQueue]) {
    if (!knownSpeechIds.has(speech.id)) {
      merged.speechQueue.push(speech);
      knownSpeechIds.add(speech.id);
    }
  }
  for (const [key, value] of Object.entries(mergedParagraphs)) {
    applyOne(merged, key, value);
  }
  return { state: merged, conflicts };
}

export function paragraphLabel(key: string, state?: ConferenceState): string {
  if (key === 'queue') return '发言顺序';
  if (key === 'adjustments') return '加减入账记录';
  if (key === 'audits') return '操作时间线';
  if (key === 'channels') return '频道与译员';
  if (key === 'terms') return '术语库';
  if (key === 'captions') return '实时字幕';
  if (key === 'activeRoomId') return '当前会议厅';
  if (key === 'lowLatency') return '低延迟模式';

  const match = key.match(/^(room|speech):([^:]+):(.+)$/);
  if (match) {
    const [, kind, id, field] = match;
    if (kind === 'room') {
      const room = state?.rooms.find((item) => item.id === id);
      const roomName = room?.name ?? id;
      const fieldLabels: Record<string, string> = {
        capacitySeconds: '厅内容量',
        name: '厅名',
        topic: '议题',
        simultaneousChannels: '同传频道数',
      };
      return `${roomName} · ${fieldLabels[field] ?? field}`;
    }
    const speech = state?.speechQueue.find((item) => item.id === id);
    const speaker = speech?.speaker ?? id;
    const fieldLabels: Record<string, string> = {
      status: '发言状态',
      plannedSeconds: '计划时长',
      remainingSeconds: '剩余时长',
      order: '发言顺序',
      roomId: '所属会议厅',
      speaker: '发言人',
      delegation: '代表团',
      language: '语言',
      topic: '议题',
    };
    return `${speaker} · ${fieldLabels[field] ?? field}`;
  }
  return key;
}

export function summarizeValue(key: string, value: unknown): string {
  if (key === 'queue') return `发言顺序 ${(value as unknown[]).length} 条`;
  if (Array.isArray(value)) return `${value.length} 条记录`;
  if (key.endsWith(':status')) return statusLabel(String(value));
  if (key === 'lowLatency') return value ? '开启' : '关闭';
  if (key.endsWith(':capacitySeconds') || key.endsWith(':plannedSeconds') || key.endsWith(':remainingSeconds')) {
    return `${Number(value)} 秒`;
  }
  return String(value);
}
