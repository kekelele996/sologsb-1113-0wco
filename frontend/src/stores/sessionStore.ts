import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { threeWayMerge, fieldLabel, isEqualValue, type RecordConflict } from '../utils/merge';
import { uid } from '../utils/id';
import type { ObsSession, SessionStatus, TelescopeStatus } from '../types';
import { useEquipmentStore } from './equipmentStore';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
}

/** 保存结果：已保存 / 冲突待裁决 / 设备不可用已退回重排 */
export type SessionSaveOutcome =
  | { status: 'saved'; row: ObsSession }
  | { status: 'conflict'; conflict: RecordConflict }
  | { status: 'reschedule'; row: ObsSession; equipment: { code: string; from: TelescopeStatus; to: TelescopeStatus } };

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<SessionSaveOutcome>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<SessionSaveOutcome>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /** 冲突裁决后写入用户选定的完整记录 */
  resolveSessionConflict: (row: ObsSession) => Promise<SessionSaveOutcome>;
}

/** 参与三向合并的排程段字段 */
const SESSION_FIELDS = [
  'nightId',
  'targetId',
  'startTime',
  'endTime',
  'telescopeId',
  'instrumentId',
  'filterSlot',
  'plannedFrames',
  'status',
  'rescheduleReason',
  'backupNightId',
] as const;

/**
 * 保存前校验望远镜状态：设备页签若已把望远镜置为「维护中/外出」，而本页签还拿着旧状态，
 * 则把该排程段标记为「退回重排」，并在改期原因里写明是哪台设备变了。
 */
async function checkEquipment(row: Omit<ObsSession, 'rev'>): Promise<{
  row: Omit<ObsSession, 'rev'>;
  equipment?: { code: string; from: TelescopeStatus; to: TelescopeStatus };
}> {
  const telescope = await db.telescopes.get(row.telescopeId);
  if (!telescope || telescope.status === '可用') {
    return { row: { ...row, needsReschedule: false } };
  }
  const baseStatus = useEquipmentStore.getState().telescopes.find((item) => item.id === row.telescopeId)?.status ?? telescope.status;
  const changed = baseStatus !== telescope.status;
  const reason = `设备 ${telescope.code} 当前为「${telescope.status}」${changed ? `（原「${baseStatus}」）` : ''}，本排程段需退回重排`;
  const prev = row.rescheduleReason?.trim();
  return {
    row: { ...row, needsReschedule: true, rescheduleReason: prev ? `${prev}；${reason}` : reason },
    equipment: { code: telescope.code, from: baseStatus, to: telescope.status },
  };
}

/** 排程段与冲突检测所需数据 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const session: Omit<ObsSession, 'rev'> = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      schemaVersion: SCHEMA_VERSION,
    };
    const { row, equipment } = await checkEquipment(session);
    const saved = await persistRow<ObsSession>('sessions', row);
    set({ sessions: [...get().sessions, saved] });
    return equipment ? { status: 'reschedule', row: saved, equipment } : { status: 'saved', row: saved };
  },

  updateSession: async (id, patch) => {
    const base = get().sessions.find((session) => session.id === id);
    if (!base) {
      return { status: 'saved', row: { id, ...patch } as unknown as ObsSession };
    }
    const theirs = await db.sessions.get(id);
    const ours: ObsSession = { ...base, ...patch, schemaVersion: SCHEMA_VERSION };

    if (!theirs) {
      // 对方页签已删除该记录：本页签若有改动则作为冲突（删除 vs 修改），交用户裁决
      const oursRecord = ours as unknown as Record<string, unknown>;
      const baseRecord = base as unknown as Record<string, unknown>;
      const changedFields = SESSION_FIELDS.filter((field) => !isEqualValue(oursRecord[field], baseRecord[field]));
      return {
        status: 'conflict',
        conflict: {
          table: 'sessions',
          recordId: id,
          recordLabel: '排程段',
          fields: changedFields.map((field) => ({
            field,
            label: fieldLabel(field),
            base: baseRecord[field],
            ours: oursRecord[field],
            theirs: undefined,
          })),
          ours: oursRecord,
          theirs: {},
          theirsMissing: true,
        },
      };
    }

    if (theirs.rev === base.rev) {
      // 对方未改动（rev 未变）：直接写入我方
      const { row, equipment } = await checkEquipment(ours);
      const saved = await persistRow<ObsSession>('sessions', row);
      set({ sessions: get().sessions.map((session) => (session.id === id ? saved : session)) });
      return equipment ? { status: 'reschedule', row: saved, equipment } : { status: 'saved', row: saved };
    }

    // 对方也改过：三向合并，摊开差异
    const { merged, conflicts } = threeWayMerge(base, ours, theirs, SESSION_FIELDS);
    if (conflicts.length > 0) {
      return {
        status: 'conflict',
        conflict: {
          table: 'sessions',
          recordId: id,
          recordLabel: '排程段',
          fields: conflicts,
          ours: ours as unknown as Record<string, unknown>,
          theirs: theirs as unknown as Record<string, unknown>,
        },
      };
    }

    // 字段级自动合并（两边改动不重叠）：再做设备可用性校验
    const { row, equipment } = await checkEquipment(merged);
    const saved = await persistRow<ObsSession>('sessions', row);
    set({ sessions: get().sessions.map((session) => (session.id === id ? saved : session)) });
    return equipment ? { status: 'reschedule', row: saved, equipment } : { status: 'saved', row: saved };
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const updated = targets.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      schemaVersion: SCHEMA_VERSION,
    }));
    for (const session of updated) {
      const saved = await persistRow<ObsSession>('sessions', session);
      set({ sessions: get().sessions.map((item) => (item.id === session.id ? saved : item)) });
    }
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  resolveSessionConflict: async (row) => {
    const { row: checked, equipment } = await checkEquipment(row);
    const saved = await persistRow<ObsSession>('sessions', checked);
    set({ sessions: get().sessions.map((session) => (session.id === saved.id ? saved : session)) });
    return equipment ? { status: 'reschedule', row: saved, equipment } : { status: 'saved', row: saved };
  },
}));
