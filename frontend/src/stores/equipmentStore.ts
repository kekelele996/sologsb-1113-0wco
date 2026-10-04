import { create } from 'zustand';
import { db, deleteRow, notifyTablesChanged } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { commitRow, mergeByFields, revisionOf } from '../utils/revision';
import type { CommitConflict, FieldOfView, Instrument, Telescope, TelescopeStatus, TerminalType } from '../types';

export interface TelescopeInput {
  code: string;
  apertureMm: number;
  focalLengthMm: number;
  mount: string;
  terminals: TerminalType[];
  maxPayloadKg: number;
  status: TelescopeStatus;
}

export interface InstrumentInput {
  model: string;
  terminalType: TerminalType;
  pixelSizeUm: number;
  sensorWidthMm: number;
  sensorHeightMm: number;
  readNoiseE: number;
  telescopeCode: string;
}

export type SaveTelescopeResult =
  | { type: 'saved'; telescope: Telescope; unchanged: boolean }
  | { type: 'conflict'; outcome: CommitConflict<Telescope> };

export type SaveInstrumentResult =
  | { type: 'saved'; instrument: Instrument; unchanged: boolean }
  | { type: 'conflict'; outcome: CommitConflict<Instrument> };

interface EquipmentState {
  telescopes: Telescope[];
  instruments: Instrument[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTelescope: (input: TelescopeInput) => Promise<Telescope>;
  updateTelescope: (id: string, patch: Partial<TelescopeInput>) => Promise<void>;
  /** 乐观锁保存整条望远镜（expectedRevision 缺省为新增） */
  saveTelescope: (telescope: Telescope, expectedRevision?: number) => Promise<SaveTelescopeResult>;
  /** 冲突裁决后按字段合并落库 */
  resolveTelescope: (
    current: Telescope,
    attempted: Telescope,
    sideByField: Record<string, 'mine' | 'theirs'>,
  ) => Promise<SaveTelescopeResult>;
  removeTelescope: (id: string) => Promise<void>;
  addInstrument: (input: InstrumentInput) => Promise<Instrument>;
  updateInstrument: (id: string, patch: Partial<InstrumentInput>) => Promise<void>;
  /** 乐观锁保存整条终端适配 */
  saveInstrument: (instrument: Instrument, expectedRevision?: number) => Promise<SaveInstrumentResult>;
  /** 冲突裁决后按字段合并落库 */
  resolveInstrument: (
    current: Instrument,
    attempted: Instrument,
    sideByField: Record<string, 'mine' | 'theirs'>,
  ) => Promise<SaveInstrumentResult>;
  removeInstrument: (id: string) => Promise<void>;
  /** 按靶面与焦距换算视场角 */
  fieldOfView: (telescopeId: string, instrumentId: string) => FieldOfView;
}

const RAD = Math.PI / 180;

/** 望远镜与终端分配（含视场角换算） */
export const useEquipmentStore = create<EquipmentState>()((set, get) => ({
  telescopes: [],
  instruments: [],
  hydrated: false,

  hydrate: async () => {
    const [telescopes, instruments] = await Promise.all([db.telescopes.orderBy('code').toArray(), db.instruments.toArray()]);
    set({ telescopes, instruments, hydrated: true });
  },

  addTelescope: async (input) => {
    const telescope: Telescope = {
      id: uid('tel'),
      code: input.code.trim(),
      apertureMm: Number(input.apertureMm) || 0,
      focalLengthMm: Number(input.focalLengthMm) || 0,
      mount: input.mount.trim(),
      terminals: input.terminals.length ? input.terminals : ['CMOS 相机'],
      maxPayloadKg: Number(input.maxPayloadKg) || 0,
      status: input.status,
      revision: revisionOf(undefined),
    };
    const outcome = await commitRow('telescopes', telescope);
    notifyTablesChanged(['telescopes']);
    const saved = outcome.type === 'saved' ? outcome.row : telescope;
    set({ telescopes: [...get().telescopes, saved].sort((a, b) => a.code.localeCompare(b.code)) });
    return saved;
  },

  updateTelescope: async (id, patch) => {
    const current = get().telescopes.find((telescope) => telescope.id === id);
    if (!current) return;
    const next: Telescope = { ...current, ...patch, revision: revisionOf(current) };
    const outcome = await commitRow('telescopes', next, revisionOf(current));
    notifyTablesChanged(['telescopes']);
    if (outcome.type === 'saved') {
      set({ telescopes: get().telescopes.map((telescope) => (telescope.id === id ? outcome.row : telescope)) });
    }
  },

  saveTelescope: async (telescope, expectedRevision) => {
    const outcome = await commitRow('telescopes', telescope, expectedRevision);
    notifyTablesChanged(['telescopes']);
    if (outcome.type === 'saved') {
      set((state) => ({
        telescopes: state.telescopes
          .filter((item) => item.id !== outcome.row.id)
          .concat(outcome.row)
          .sort((a, b) => a.code.localeCompare(b.code)),
      }));
      return { type: 'saved', telescope: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  resolveTelescope: async (current, attempted, sideByField) => {
    const merged = mergeByFields(current, attempted, sideByField);
    const outcome = await commitRow('telescopes', merged, revisionOf(current));
    notifyTablesChanged(['telescopes']);
    if (outcome.type === 'saved') {
      set((state) => ({
        telescopes: state.telescopes
          .filter((item) => item.id !== outcome.row.id)
          .concat(outcome.row)
          .sort((a, b) => a.code.localeCompare(b.code)),
      }));
      return { type: 'saved', telescope: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  removeTelescope: async (id) => {
    await deleteRow('telescopes', id);
    set({ telescopes: get().telescopes.filter((telescope) => telescope.id !== id) });
  },

  addInstrument: async (input) => {
    const instrument: Instrument = {
      id: uid('ins'),
      model: input.model.trim(),
      terminalType: input.terminalType,
      pixelSizeUm: Number(input.pixelSizeUm) || 0,
      sensorWidthMm: Number(input.sensorWidthMm) || 0,
      sensorHeightMm: Number(input.sensorHeightMm) || 0,
      readNoiseE: Number(input.readNoiseE) || 0,
      telescopeCode: input.telescopeCode,
      revision: revisionOf(undefined),
    };
    const outcome = await commitRow('instruments', instrument);
    notifyTablesChanged(['instruments']);
    const saved = outcome.type === 'saved' ? outcome.row : instrument;
    set({ instruments: [...get().instruments, saved] });
    return saved;
  },

  updateInstrument: async (id, patch) => {
    const current = get().instruments.find((instrument) => instrument.id === id);
    if (!current) return;
    const next: Instrument = { ...current, ...patch, revision: revisionOf(current) };
    const outcome = await commitRow('instruments', next, revisionOf(current));
    notifyTablesChanged(['instruments']);
    if (outcome.type === 'saved') {
      set({ instruments: get().instruments.map((instrument) => (instrument.id === id ? outcome.row : instrument)) });
    }
  },

  saveInstrument: async (instrument, expectedRevision) => {
    const outcome = await commitRow('instruments', instrument, expectedRevision);
    notifyTablesChanged(['instruments']);
    if (outcome.type === 'saved') {
      set((state) => ({
        instruments: state.instruments.map((item) => (item.id === outcome.row.id ? outcome.row : item)),
      }));
      return { type: 'saved', instrument: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  resolveInstrument: async (current, attempted, sideByField) => {
    const merged = mergeByFields(current, attempted, sideByField);
    const outcome = await commitRow('instruments', merged, revisionOf(current));
    notifyTablesChanged(['instruments']);
    if (outcome.type === 'saved') {
      set((state) => ({
        instruments: state.instruments.map((item) => (item.id === outcome.row.id ? outcome.row : item)),
      }));
      return { type: 'saved', instrument: outcome.row, unchanged: outcome.unchanged };
    }
    return { type: 'conflict', outcome };
  },

  removeInstrument: async (id) => {
    await deleteRow('instruments', id);
    set({ instruments: get().instruments.filter((instrument) => instrument.id !== id) });
  },

  fieldOfView: (telescopeId, instrumentId) => {
    const telescope = get().telescopes.find((item) => item.id === telescopeId);
    const instrument = get().instruments.find((item) => item.id === instrumentId);
    if (!telescope || !instrument || telescope.focalLengthMm <= 0) {
      return { widthDeg: 0, heightDeg: 0, arcsecPerPixel: 0, text: '设备信息不完整，无法换算视场角' };
    }
    const widthDeg = (2 * Math.atan(instrument.sensorWidthMm / (2 * telescope.focalLengthMm))) / RAD;
    const heightDeg = (2 * Math.atan(instrument.sensorHeightMm / (2 * telescope.focalLengthMm))) / RAD;
    const arcsecPerPixel = (instrument.pixelSizeUm / telescope.focalLengthMm) * 206.265;
    return {
      widthDeg: Number(widthDeg.toFixed(2)),
      heightDeg: Number(heightDeg.toFixed(2)),
      arcsecPerPixel: Number(arcsecPerPixel.toFixed(2)),
      text: `${widthDeg.toFixed(2)}° × ${heightDeg.toFixed(2)}°（${arcsecPerPixel.toFixed(2)}″/px）`,
    };
  },
}));
