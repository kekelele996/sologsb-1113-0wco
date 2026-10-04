import { create } from 'zustand';
import { db, deleteRow, notifyTablesChanged, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { commitRow, mergeByFields, revisionOf } from '../utils/revision';
import type { CommitConflict, ObsSession, SessionStatus, StaleTelescopeBlock, Telescope } from '../types';

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

/** 单条排程段保存结果：正常落库 / 同记录并发冲突 / 望远镜已被设备侧置为不可用而退回 */
export type SaveSessionResult =
  | { type: 'saved'; session: ObsSession; unchanged: boolean }
  | { type: 'conflict'; outcome: CommitConflict<ObsSession> }
  | { type: 'telescope-blocked'; block: StaleTelescopeBlock };

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 乐观锁保存整条排程段（expectedRevision 缺省为新增）；保存时校验望远镜是否仍可排 */
  saveSession: (
    session: ObsSession,
    expectedRevision: number | undefined,
    seenTelescopeStatus?: string,
  ) => Promise<SaveSessionResult>;
  /** 新建排程段（先构造未入库记录，保存时过乐观锁与望远镜可用性校验） */
  createSession: (input: SessionInput) => ObsSession;
  /** 冲突裁决后按字段合并落库 */
  resolveSession: (
    current: ObsSession,
    attempted: ObsSession,
    sideByField: Record<string, 'mine' | 'theirs'>,
    seenTelescopeStatus?: string,
  ) => Promise<SaveSessionResult>;
  /** 批量改期到备用观测夜并填写改期原因（逐条乐观锁，返回每条的结果） */
  rescheduleToBackup: (
    ids: string[],
    backupNightId: string,
    reason: string,
    telescopeStatusById: Map<string, string>,
  ) => Promise<SaveSessionResult[]>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
}

function normalize(input: ObsSession): ObsSession {
  return {
    ...input,
    plannedFrames: Number(input.plannedFrames) || 0,
    rescheduleReason: input.rescheduleReason?.trim() || undefined,
    schemaVersion: SCHEMA_VERSION,
  };
}

/** 保存排程段前的设备侧校验：望远镜已被标为维护中 / 外出则退回重排 */
async function checkTelescopeAvailable(
  telescopeId: string,
  seenStatus?: string,
): Promise<StaleTelescopeBlock | null> {
  const telescope = (await db.telescopes.get(telescopeId)) as Telescope | undefined;
  if (!telescope) return null;
  if (telescope.status === '维护中' || telescope.status === '外出') {
    if (!seenStatus || seenStatus !== telescope.status) {
      return {
        telescopeId,
        telescopeCode: telescope.code,
        currentStatus: telescope.status,
        seenStatus: seenStatus ?? '可用',
      };
    }
  }
  return null;
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
    const session: ObsSession = normalize({
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
      revision: revisionOf(undefined),
    });
    const outcome = await commitRow('sessions', session);
    notifyTablesChanged(['sessions']);
    const saved = outcome.type === 'saved' ? outcome.row : session;
    set({ sessions: [...get().sessions, saved] });
    return saved;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const next: ObsSession = normalize({ ...current, ...patch, revision: revisionOf(current) });
    const outcome = await commitRow('sessions', next, revisionOf(current));
    notifyTablesChanged(['sessions']);
    if (outcome.type === 'saved') {
      set({ sessions: get().sessions.map((session) => (session.id === id ? outcome.row : session)) });
    }
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  createSession: (input) =>
    normalize({
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
      revision: revisionOf(undefined),
    }),

  saveSession: async (session, expectedRevision, seenTelescopeStatus) => {
    const attempted = normalize(session);
    const block = await checkTelescopeAvailable(attempted.telescopeId, seenTelescopeStatus);
    if (block) return { type: 'telescope-blocked', block };

    const outcome = await commitRow('sessions', attempted, expectedRevision);
    notifyTablesChanged(['sessions']);
    if (outcome.type === 'saved') {
      set((state) => {
        const exists = state.sessions.some((item) => item.id === outcome.row.id);
        return {
          sessions: exists
            ? state.sessions.map((item) => (item.id === outcome.row.id ? outcome.row : item))
            : [...state.sessions, outcome.row],
        };
      });
      return { type: 'saved', session: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  resolveSession: async (current, attempted, sideByField, seenTelescopeStatus) => {
    // 合并后的望远镜 id 决定设备侧状态校验：若望远镜字段采用我方，则以本页签看到的旧状态作基线，
    // 期间设备侧已改为维护中/外出就退回；采用对方值时对方保存时已做过校验，无需再拦。
    const pickedTelescopeId =
      sideByField.telescopeId === 'mine' ? attempted.telescopeId : current.telescopeId;
    const block = await checkTelescopeAvailable(
      pickedTelescopeId,
      sideByField.telescopeId === 'mine' ? seenTelescopeStatus : undefined,
    );
    if (block) return { type: 'telescope-blocked', block };

    const merged = mergeByFields(current, attempted, sideByField);
    const outcome = await commitRow('sessions', normalize(merged), revisionOf(current));
    notifyTablesChanged(['sessions']);
    if (outcome.type === 'saved') {
      set((state) => ({
        sessions: state.sessions.map((item) => (item.id === outcome.row.id ? outcome.row : item)),
      }));
      return { type: 'saved', session: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  rescheduleToBackup: async (ids, backupNightId, reason, telescopeStatusById) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const results: SaveSessionResult[] = [];
    for (const session of targets) {
      // eslint-disable-next-line no-await-in-loop
      const result = await get().saveSession(
        {
          ...session,
          backupNightId,
          status: '因云取消',
          rescheduleReason: reason.trim() || '改期至备用观测夜',
        },
        revisionOf(session),
        telescopeStatusById.get(session.telescopeId),
      );
      results.push(result);
    }
    return results;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },
}));
