import {
  createConference,
  migrateV1,
  type ConferenceTimingState
} from './core';

/** 新版按厅发言计时数据（v2） */
export const TIMING_STORAGE_KEY = 'conference-timing-v2';
/** 旧版同传控制台数据（v1），存在时自动升级 */
export const LEGACY_STORAGE_KEY = 'conference-interpretation-v1';

export interface LoadResult {
  state: ConferenceTimingState;
  /** 每个厅的升级说明 */
  migrationMessages: string[];
}

export function loadTimingState(storage: Storage | undefined): LoadResult {
  if (!storage) return { state: seedState(), migrationMessages: [] };

  const raw = storage.getItem(TIMING_STORAGE_KEY);
  if (raw) {
    try {
      return { state: JSON.parse(raw) as ConferenceTimingState, migrationMessages: [] };
    } catch {
      // 解析失败则继续走重建
    }
  }

  // 旧数据升级：按原计划时长补齐，容量按厅给足，放不下时降级并写明差额
  const legacyRaw = storage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as Parameters<typeof migrateV1>[0];
      const state = migrateV1(legacy, { capacitySeconds: 7200 });
      const messages = Object.values(state.halls).flatMap((hall) =>
        hall.ledger.filter((entry) => entry.kind === 'migrate').map((entry) => `${hall.name}：${entry.message}`)
      );
      return { state, migrationMessages: messages };
    } catch {
      // 旧数据损坏时降级到演示数据
    }
  }

  return { state: seedState(), migrationMessages: [] };
}

export function saveTimingState(storage: Storage | undefined, state: ConferenceTimingState): void {
  storage?.setItem(TIMING_STORAGE_KEY, JSON.stringify(state));
}

/** 演示数据：A 厅容量故意设小，最后一位代表会被降级为候补并写明差额 */
export function seedState(): ConferenceTimingState {
  return createConference([
    { id: 'hall-a', name: 'A厅 · 全体会议', capacitySeconds: 900 },
    { id: 'hall-b', name: 'B厅 · 技术分会', capacitySeconds: 1200 }
  ]);
}

/** 当前浏览器窗口（标签页）标识，用于多窗口并发保存 */
export function getWindowId(): string {
  if (typeof sessionStorage === 'undefined') return 'server';
  let id = sessionStorage.getItem('timing-window-id');
  if (!id) {
    id = `窗口-${Math.random().toString(36).slice(2, 6)}`;
    sessionStorage.setItem('timing-window-id', id);
  }
  return id;
}
