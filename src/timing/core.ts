/**
 * 按厅发言计时内核（纯函数，不依赖任何 DOM / 框架）。
 *
 * 规则对照：
 * - 按会议厅分别维护：一切状态挂在 HallState 上，各厅版本、账本、队列互不串账。
 * - 每次改动累加：修改时长/顺序/插话都生成一条 ledger，duration 变动记成一笔 Adjustment。
 * - 任一处修改都让后续时段重算：recomputeHall 每次从头重排 start/end。
 * - 超容量：从排在最后的代表开始降级为候补，并写明差多少秒。
 * - 提前结束：实际占用小于计划，空出的秒数还回厅里（供后面的人使用 + 累计展示）。
 * - 两个窗口同改一厅：基于版本号乐观提交，改的段落不重叠则合并且不覆盖彼此的加减，
 *   重叠则拒绝并列出各自改过的段落。
 * - 旧数据升级：按原计划时长补齐为 v2。
 */

export type SegmentType = 'delegate' | 'interjection';
export type SegmentStatus = 'scheduled' | 'done' | 'waitlisted';

export interface Adjustment {
  /** 每次时长调整的秒数增量，如 -60 表示缩短一分钟；同一笔改动可以多笔累加 */
  deltaSeconds: number;
  reason: string;
  windowId: string;
  at: string;
}

export interface TimelineSegment {
  id: string;
  type: SegmentType;
  /** 代表姓名 / 插话来源 */
  label: string;
  delegation: string;
  /** 原定计划秒数，创建后不变；实际生效秒数 = planned + 所有 Adjustment.delta */
  plannedSeconds: number;
  /** 已结束发言实际占用秒数；存在时以它为准（提前结束会小于生效秒数） */
  actualSeconds?: number;
  adjustments: Adjustment[];
  status: SegmentStatus;
  order: number;
  /** 候补入列的先后，用于 FIFO 递补 */
  waitlistOrder?: number;
  /** 降级为候补时写明的差额秒数（当时还差多少秒才放得下） */
  demotedShortfall?: number;
  note?: string;
}

export type LedgerKind =
  | 'add'
  | 'remove'
  | 'duration'
  | 'reorder'
  | 'interjection'
  | 'early-end'
  | 'demote'
  | 'promote'
  | 'migrate'
  | 'merge'
  | 'conflict';

export interface LedgerEntry {
  id: string;
  at: string;
  windowId: string;
  kind: LedgerKind;
  /** 改动涉及的段落 id */
  segmentIds: string[];
  message: string;
  /** 产生该条改动后厅的版本号（随数据持久化，刷新后仍可判断并发） */
  version?: number;
}

export interface HallState {
  schemaVersion: 2;
  id: string;
  name: string;
  /** 厅内时间容量（秒） */
  capacitySeconds: number;
  segments: TimelineSegment[];
  ledger: LedgerEntry[];
  /** 厅内每次保存自增，供多窗口乐观锁使用 */
  version: number;
  /** 提前结束累计还回厅里的秒数 */
  returnedSeconds: number;
  waitlistCounter: number;
}

export interface ConferenceTimingState {
  halls: Record<string, HallState>;
}

/** 重算后时间线上的一个时段 */
export interface TimeSlot {
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  overflow: boolean;
}

export interface TimelineResult {
  slots: TimeSlot[];
  usedSeconds: number;
  freeSeconds: number;
  /** 即使全部降级仍放不下（插话把厅塞满）时为 true */
  overCapacity: boolean;
  overflowSeconds: number;
  scheduledCount: number;
  waitlisted: TimelineSegment[];
}

export type ChangeKind =
  | 'addDelegate'
  | 'addInterjection'
  | 'adjustDuration'
  | 'earlyEnd'
  | 'reorder'
  | 'remove'
  | 'setCapacity';

export interface Change {
  kind: ChangeKind;
  windowId: string;
  segmentId?: string;
  /** addDelegate / addInterjection */
  label?: string;
  delegation?: string;
  plannedSeconds?: number;
  /** addInterjection：插到第几位之前（顺序索引），默认末尾 */
  beforeOrder?: number;
  /** adjustDuration */
  deltaSeconds?: number;
  reason?: string;
  /** earlyEnd */
  actualSeconds?: number;
  /** reorder：移动到的新顺序索引 */
  toOrder?: number;
}

export interface SaveResult {
  ok: boolean;
  hall: HallState;
  timeline: TimelineResult;
  /** 合并了另一窗口改动时，列出双方各自改过的段落 */
  mergedFromOther?: { windowId: string; segmentIds: string[] }[];
  /** 段落级冲突，本次保存被拒绝 */
  conflict?: {
    currentWindow: { windowId: string; segmentIds: string[] };
    otherWindow: { windowId: string; segmentIds: string[] };
  };
}

export function effectiveSeconds(segment: TimelineSegment): number {
  const delta = segment.adjustments.reduce((sum, item) => sum + item.deltaSeconds, 0);
  return Math.max(0, segment.plannedSeconds + delta);
}

export function occupiedSeconds(segment: TimelineSegment): number {
  if (segment.status === 'done' && segment.actualSeconds !== undefined) {
    return Math.max(0, segment.actualSeconds);
  }
  return effectiveSeconds(segment);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let seq = 0;
function makeId(prefix: string): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function createHall(id: string, name: string, capacitySeconds: number): HallState {
  return {
    schemaVersion: 2,
    id,
    name,
    capacitySeconds,
    segments: [],
    ledger: [],
    version: 0,
    returnedSeconds: 0,
    waitlistCounter: 0
  };
}

export function createConference(halls: { id: string; name: string; capacitySeconds: number }[]): ConferenceTimingState {
  return { halls: Object.fromEntries(halls.map((hall) => [hall.id, createHall(hall.id, hall.name, hall.capacitySeconds)])) };
}

/**
 * 从头重算某厅：重排 order、计算时间线、超出容量时把最后的代表逐个降级为候补，
 * 空出容量后再按候补 FIFO 尝试递补。重算产生的账本归属触发它的窗口。
 */
export function recomputeHall(hall: HallState, actorWindowId = 'system'): TimelineResult {
  // 1. 重排 order（候补不占时间线）
  const scheduled = hall.segments
    .filter((segment) => segment.status !== 'waitlisted')
    .sort((a, b) => a.order - b.order);
  const waitlisted = hall.segments
    .filter((segment) => segment.status === 'waitlisted')
    .sort((a, b) => (a.waitlistOrder ?? 0) - (b.waitlistOrder ?? 0));

  scheduled.forEach((segment, index) => {
    segment.order = index;
  });

  const totalOf = (list: TimelineSegment[]) => list.reduce((sum, segment) => sum + occupiedSeconds(segment), 0);

  // 2. 超出容量：从排在最后的代表开始降级，写明差多少秒；插话不降级
  const demotions: { segment: TimelineSegment; shortfall: number }[] = [];
  let guard = 0;
  while (guard++ < 10000) {
    const overflow = totalOf(scheduled) - hall.capacitySeconds;
    if (overflow <= 0) break;
    const lastDelegate = [...scheduled].reverse().find((segment) => segment.type === 'delegate');
    if (!lastDelegate) break; // 只剩插话仍超时：厅本身过载，见 overCapacity
    lastDelegate.status = 'waitlisted';
    lastDelegate.demotedShortfall = overflow;
    hall.waitlistCounter += 1;
    lastDelegate.waitlistOrder = hall.waitlistCounter;
    demotions.push({ segment: lastDelegate, shortfall: overflow });
    scheduled.splice(scheduled.indexOf(lastDelegate), 1);
    waitlisted.push(lastDelegate);
  }

  for (const demotion of demotions) {
    hall.ledger.push({
      id: makeId('led'),
      at: new Date().toISOString(),
      windowId: actorWindowId,
      kind: 'demote',
      segmentIds: [demotion.segment.id],
      message: `容量不足，${demotion.segment.label} 降级为候补（差 ${demotion.shortfall} 秒）`
    });
  }

  // 3. 有空闲容量时按 FIFO 尝试把候补代表递补到队尾。
  //    即使厅已排满，候补自身时长被改短时也要重新评估（改短后可能恰好放得下）。
  const promotions: TimelineSegment[] = [];
  let guard2 = 0;
  while (guard2++ < 10000) {
    const candidate = waitlisted.find((segment) => segment.type === 'delegate');
    if (!candidate) break;
    const duration = occupiedSeconds(candidate);
    if (duration > hall.capacitySeconds - totalOf(scheduled)) break;
    candidate.status = 'scheduled';
    candidate.demotedShortfall = undefined;
    candidate.waitlistOrder = undefined;
    candidate.order = scheduled.length;
    scheduled.push(candidate);
    waitlisted.splice(waitlisted.indexOf(candidate), 1);
    promotions.push(candidate);
  }

  for (const segment of promotions) {
    hall.ledger.push({
      id: makeId('led'),
      at: new Date().toISOString(),
      windowId: actorWindowId,
      kind: 'promote',
      segmentIds: [segment.id],
      message: `容量空余，候补代表 ${segment.label} 递补回发言队列`
    });
  }

  // 4. 生成时间线（含超出容量边界的时段标记）
  const slots: TimeSlot[] = [];
  let cursor = 0;
  for (const segment of scheduled) {
    const duration = occupiedSeconds(segment);
    const end = cursor + duration;
    slots.push({
      segmentId: segment.id,
      startSeconds: cursor,
      endSeconds: end,
      durationSeconds: duration,
      overflow: cursor < hall.capacitySeconds && end > hall.capacitySeconds
    });
    cursor = end;
  }

  waitlisted.sort((a, b) => (a.waitlistOrder ?? 0) - (b.waitlistOrder ?? 0));
  const used = totalOf(scheduled);
  return {
    slots,
    usedSeconds: used,
    freeSeconds: Math.max(0, hall.capacitySeconds - used),
    overCapacity: used > hall.capacitySeconds,
    overflowSeconds: Math.max(0, used - hall.capacitySeconds),
    scheduledCount: scheduled.length,
    waitlisted
  };
}

/** 把一批改动作用到厅上（调用方负责克隆），返回受影响段落 id；不自行重算。 */
function applyChanges(hall: HallState, changes: Change[]): string[] {
  const touched: string[] = [];
  const touch = (id: string) => {
    if (!touched.includes(id)) touched.push(id);
  };
  const log = (entry: Omit<LedgerEntry, 'id' | 'at'>) => {
    hall.ledger.push({ id: makeId('led'), at: new Date().toISOString(), ...entry });
  };

  for (const change of changes) {
    const windowId = change.windowId || 'unknown';
    if (change.kind === 'setCapacity') continue; // 厅级变更，循环结束后统一处理
    if (change.kind === 'addDelegate' || change.kind === 'addInterjection') {
      const isInterjection = change.kind === 'addInterjection';
      const active = hall.segments
        .filter((segment) => segment.status !== 'waitlisted')
        .sort((a, b) => a.order - b.order);
      const id = makeId(isInterjection ? 'int' : 'del');
      const index = change.beforeOrder === undefined ? active.length : Math.max(0, Math.min(change.beforeOrder, active.length));
      // 在 index 处插入：后面的段落顺延
      active.slice(index).forEach((segment) => {
        segment.order += 1;
      });
      const segment: TimelineSegment = {
        id,
        type: isInterjection ? 'interjection' : 'delegate',
        label: change.label ?? (isInterjection ? '临时插话' : '未命名代表'),
        delegation: change.delegation ?? '',
        plannedSeconds: Math.max(0, change.plannedSeconds ?? 0),
        adjustments: [],
        status: 'scheduled',
        order: index,
        note: isInterjection ? '临时插话' : undefined
      };
      hall.segments.push(segment);
      touch(id);
      log({
        windowId,
        kind: isInterjection ? 'interjection' : 'add',
        segmentIds: [id],
        message: isInterjection
          ? `临时插话「${segment.label}」入账 ${segment.plannedSeconds} 秒，插入第 ${index + 1} 位`
          : `代表 ${segment.label} 加入队列，计划 ${segment.plannedSeconds} 秒`
      });
      continue;
    }

    const segment = change.segmentId ? hall.segments.find((item) => item.id === change.segmentId) : undefined;
    if (!segment || !change.segmentId) {
      throw new Error(`改动引用的段落不存在：${change.segmentId ?? '(空)'}`);
    }

    switch (change.kind) {
      case 'adjustDuration': {
        const delta = change.deltaSeconds ?? 0;
        segment.adjustments.push({
          deltaSeconds: delta,
          reason: change.reason ?? '时长调整',
          windowId,
          at: new Date().toISOString()
        });
        // 候补段落时长改短后，交给 recomputeHall 决定是否能递补
        touch(segment.id);
        log({
          windowId,
          kind: 'duration',
          segmentIds: [segment.id],
          message: `${segment.label} 时长 ${delta >= 0 ? '+' : ''}${delta} 秒（${change.reason ?? '时长调整'}），生效 ${effectiveSeconds(segment)} 秒，后续时段重算`
        });
        break;
      }
      case 'earlyEnd': {
        const actual = Math.max(0, change.actualSeconds ?? 0);
        const before = occupiedSeconds(segment);
        segment.actualSeconds = actual;
        segment.status = 'done';
        const returned = Math.max(0, before - actual);
        if (returned > 0) hall.returnedSeconds += returned;
        touch(segment.id);
        log({
          windowId,
          kind: 'early-end',
          segmentIds: [segment.id],
          message: `${segment.label} 提前结束，实际 ${actual} 秒，空出 ${returned} 秒还回厅里留给后面的人`
        });
        break;
      }
      case 'reorder': {
        const active = hall.segments
          .filter((item) => item.status !== 'waitlisted')
          .sort((a, b) => a.order - b.order);
        const from = active.findIndex((item) => item.id === segment.id);
        if (from >= 0) {
          const to = Math.max(0, Math.min(change.toOrder ?? from, active.length - 1));
          const [moved] = active.splice(from, 1);
          active.splice(to, 0, moved);
          active.forEach((item, index) => {
            item.order = index;
          });
          touch(segment.id);
          log({
            windowId,
            kind: 'reorder',
            segmentIds: [segment.id],
            message: `${segment.label} 从第 ${from + 1} 位移到第 ${to + 1} 位，后续时段重算`
          });
        }
        break;
      }
      case 'remove': {
        hall.segments = hall.segments.filter((item) => item.id !== segment.id);
        touch(segment.id);
        log({
          windowId,
          kind: 'remove',
          segmentIds: [segment.id],
          message: `${segment.label} 已移出本厅日程`
        });
        break;
      }
    }
  }

  // 不绑定段落的变更放最后
  for (const change of changes) {
    if (change.kind !== 'setCapacity') continue;
    const seconds = Math.max(0, change.plannedSeconds ?? hall.capacitySeconds);
    const old = hall.capacitySeconds;
    hall.capacitySeconds = seconds;
    log({
      windowId: change.windowId || 'unknown',
      kind: 'duration',
      segmentIds: [],
      message: `厅内容量 ${old} 秒改为 ${seconds} 秒，时间线与候补重算`
    });
  }

  return touched;
}

/** 改动涉及哪些段落（新增段落按 kind 标记，用临时 clientId 区分） */
function changeTouches(change: Change): string[] {
  if (change.kind === 'addDelegate' || change.kind === 'addInterjection') {
    // 新增还没有真实 id：同窗口两笔新增不视为冲突（都要保留），这里返回空
    return [];
  }
  return change.segmentId ? [change.segmentId] : [];
}

export interface CommitParams {
  conference: ConferenceTimingState;
  hallId: string;
  baseVersion: number;
  windowId: string;
  changes: Change[];
}

/** 账本条目里属于真实编辑动作的类型 */
const MUTATION_KINDS: LedgerKind[] = ['add', 'remove', 'duration', 'reorder', 'interjection', 'early-end'];

/** 另一窗口在 baseVersion 之后保存的改动条目 */
function changesAfterVersion(hall: HallState, baseVersion: number, windowId: string): LedgerEntry[] {
  return hall.ledger.filter(
    (entry) => (entry.version ?? 0) > baseVersion && entry.windowId !== windowId && MUTATION_KINDS.includes(entry.kind)
  );
}

/**
 * 提交一批改动。
 * - baseVersion 等于当前版本：直接保存。
 * - 落后于当前版本（另一窗口先保存）：段落集合不重叠则自动合并，
 *   且双方的加减逐笔保留；重叠则拒绝并返回双方各自改过的段落。
 */
export function commitChanges(params: CommitParams): SaveResult {
  const { conference, hallId, baseVersion, windowId, changes } = params;
  const current = conference.halls[hallId];
  if (!current) throw new Error(`会议厅不存在：${hallId}`);

  const ownTouched = unique(changes.flatMap(changeTouches));
  const other = changesAfterVersion(current, baseVersion, windowId);
  const otherTouched = unique(other.flatMap((entry) => entry.segmentIds));
  const otherWindowIds = unique(other.map((entry) => entry.windowId));

  if (baseVersion < current.version && ownTouched.some((id) => otherTouched.includes(id))) {
    const overlap = ownTouched.filter((id) => otherTouched.includes(id));
    // 冲突条目标当前版本但不递增版本号，避免挡住解决冲突后的重试
    current.ledger.push({
      id: makeId('led'),
      at: new Date().toISOString(),
      windowId,
      kind: 'conflict',
      segmentIds: overlap,
      version: current.version,
      message: `保存被拒绝：${windowId} 与先保存的窗口同时修改了 ${overlap.length} 个相同段落`
    });
    return {
      ok: false,
      hall: current,
      timeline: recomputeHall(clone(current), windowId),
      conflict: {
        currentWindow: { windowId, segmentIds: ownTouched },
        otherWindow: { windowId: otherWindowIds.join('、') || '另一窗口', segmentIds: otherTouched }
      }
    };
  }

  // 以当前最新厅为底（含先保存窗口的加减），再叠加本窗口改动 —— 不覆盖先前的任何加减
  const hall = clone(current);
  applyChanges(hall, changes);
  hall.version += 1;
  const timeline = recomputeHall(hall, windowId);

  // 本版本内所有新条目（含降级/递补）记录水位
  hall.ledger.forEach((entry) => {
    if (entry.version === undefined) entry.version = hall.version;
  });

  if (otherWindowIds.length > 0) {
    hall.ledger.push({
      id: makeId('led'),
      at: new Date().toISOString(),
      windowId,
      kind: 'merge',
      segmentIds: unique([...ownTouched, ...otherTouched]),
      version: hall.version,
      message: `合并保存：后保存窗口 ${windowId} 改动 ${ownTouched.length} 段，先保存窗口 ${otherWindowIds.join('、')} 改动 ${otherTouched.length} 段，双方加减均已保留`
    });
  }

  conference.halls[hallId] = hall;
  return {
    ok: true,
    hall,
    timeline,
    mergedFromOther:
      otherWindowIds.length > 0
        ? otherWindowIds.map((id) => ({
            windowId: id,
            segmentIds: unique(other.filter((entry) => entry.windowId === id).flatMap((entry) => entry.segmentIds))
          }))
        : undefined
  };
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

export interface LegacyV1Speech {
  id: string;
  roomId: string;
  speaker: string;
  delegation?: string;
  language?: string;
  plannedSeconds: number;
  status?: string;
}

export interface LegacyV1State {
  rooms?: { id: string; name?: string; topic?: string }[];
  speechQueue?: LegacyV1Speech[];
}

/**
 * 旧数据升级：v1 只有发言队列、没有厅容量/账本。
 * 已有发言按"原计划时长"补齐，队列顺序保留；容量不足时照常降级并写明差额。
 */
export function migrateV1(
  legacy: LegacyV1State,
  options: { capacitySeconds: number | Record<string, number>; defaultCapacitySeconds?: number }
): ConferenceTimingState {
  const capacityOf = (roomId: string) => {
    const capacities = options.capacitySeconds;
    if (typeof capacities === 'object') return capacities[roomId] ?? options.defaultCapacitySeconds ?? 7200;
    return capacities;
  };

  const roomIds = [
    ...(legacy.rooms?.map((room) => room.id) ?? []),
    ...(legacy.speechQueue?.map((speech) => speech.roomId) ?? [])
  ].filter((id, index, all) => all.indexOf(id) === index);

  const conference = createConference(
    roomIds.map((id) => ({
      id,
      name: legacy.rooms?.find((room) => room.id === id)?.name ?? id,
      capacitySeconds: capacityOf(id)
    }))
  );

  for (const roomId of roomIds) {
    const hall = conference.halls[roomId];
    const speeches = (legacy.speechQueue ?? []).filter((speech) => speech.roomId === roomId);
    speeches.forEach((speech, index) => {
      const skipped = speech.status === 'skipped';
      hall.segments.push({
        id: speech.id,
        type: 'delegate',
        label: speech.speaker,
        delegation: speech.delegation ?? speech.language ?? '',
        plannedSeconds: speech.plannedSeconds,
        adjustments: [],
        status: skipped ? 'done' : 'scheduled',
        actualSeconds: skipped ? 0 : undefined,
        order: index
      });
    });
    hall.ledger.push({
      id: makeId('led'),
      at: new Date().toISOString(),
      windowId: 'migration',
      kind: 'migrate',
      segmentIds: hall.segments.map((segment) => segment.id),
      version: 1,
      message: `旧数据升级：${speeches.length} 条发言按原计划时长补齐（${speeches.reduce((sum, speech) => sum + speech.plannedSeconds, 0)} 秒）`
    });
    recomputeHall(hall, 'migration');
    hall.ledger.forEach((entry) => {
      if (entry.version === undefined) entry.version = 1;
    });
    hall.version = 1;
  }

  return conference;
}
