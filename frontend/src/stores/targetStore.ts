import { create } from 'zustand';
import { db, deleteRow, notifyTablesChanged } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { commitRow, mergeByFields, revisionOf } from '../utils/revision';
import type { CommitConflict, FilterName, ObsTarget, Priority, TargetType } from '../types';

export interface TargetInput {
  name: string;
  catalog: string;
  raHours: number;
  decDeg: number;
  magnitude: number;
  type: TargetType;
  filter: FilterName;
  exposureSec: number;
  totalMinutes: number;
  priority: Priority;
  minAltitude: number;
  remark?: string;
}

export type SaveTargetResult =
  | { type: 'saved'; target: ObsTarget; unchanged: boolean }
  | { type: 'conflict'; outcome: CommitConflict<ObsTarget> };

interface TargetState {
  targets: ObsTarget[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 构造未入库的目标记录（保存时统一走乐观锁） */
  buildTargetDraft: (input: TargetInput) => ObsTarget;
  addTarget: (input: TargetInput) => Promise<ObsTarget>;
  updateTarget: (id: string, patch: Partial<TargetInput>) => Promise<void>;
  /** 乐观锁保存整条目标（expectedRevision 缺省为新增） */
  saveTarget: (target: ObsTarget, expectedRevision?: number) => Promise<SaveTargetResult>;
  /** 冲突裁决后按字段合并落库 */
  resolveTarget: (
    current: ObsTarget,
    attempted: ObsTarget,
    sideByField: Record<string, 'mine' | 'theirs'>,
  ) => Promise<SaveTargetResult>;
  removeTarget: (id: string) => Promise<void>;
}

/** 观测目标库 */
export const useTargetStore = create<TargetState>()((set, get) => ({
  targets: [],
  hydrated: false,

  hydrate: async () => {
    const targets = await db.targets.orderBy('name').toArray();
    set({ targets, hydrated: true });
  },

  buildTargetDraft: (input) => ({
    id: uid('target'),
    name: input.name.trim(),
    catalog: input.catalog.trim(),
    raHours: Number(input.raHours) || 0,
    decDeg: Number(input.decDeg) || 0,
    magnitude: Number(input.magnitude) || 0,
    type: input.type,
    filter: input.filter,
    exposureSec: Number(input.exposureSec) || 0,
    totalMinutes: Number(input.totalMinutes) || 0,
    priority: input.priority,
    minAltitude: Number(input.minAltitude) || 0,
    remark: input.remark?.trim() || undefined,
    revision: revisionOf(undefined),
  }),

  addTarget: async (input) => {
    const target = get().buildTargetDraft(input);
    const outcome = await commitRow('targets', target);
    notifyTablesChanged(['targets']);
    const saved = outcome.type === 'saved' ? outcome.row : target;
    set({ targets: [...get().targets, saved].sort((a, b) => a.name.localeCompare(b.name)) });
    return saved;
  },

  updateTarget: async (id, patch) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) return;
    const next: ObsTarget = { ...current, ...patch, revision: revisionOf(current) };
    const outcome = await commitRow('targets', next, revisionOf(current));
    notifyTablesChanged(['targets']);
    if (outcome.type === 'saved') {
      set({ targets: get().targets.map((target) => (target.id === id ? outcome.row : target)) });
    }
  },

  saveTarget: async (target, expectedRevision) => {
    const outcome = await commitRow('targets', target, expectedRevision);
    notifyTablesChanged(['targets']);
    if (outcome.type === 'saved') {
      set((state) => ({
        targets: state.targets
          .filter((item) => item.id !== outcome.row.id)
          .concat(outcome.row)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
      return { type: 'saved', target: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  resolveTarget: async (current, attempted, sideByField) => {
    const merged = mergeByFields(current, attempted, sideByField);
    const outcome = await commitRow('targets', merged, revisionOf(current));
    notifyTablesChanged(['targets']);
    if (outcome.type === 'saved') {
      set((state) => ({
        targets: state.targets
          .filter((item) => item.id !== outcome.row.id)
          .concat(outcome.row)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
      return { type: 'saved', target: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  removeTarget: async (id) => {
    await deleteRow('targets', id);
    set({ targets: get().targets.filter((target) => target.id !== id) });
  },
}));
