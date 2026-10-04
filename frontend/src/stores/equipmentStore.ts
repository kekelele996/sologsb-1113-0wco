import { create } from 'zustand';
import { db, deleteRow, persistRow } from '../hooks/usePersistentStore';
import { threeWayMerge, fieldLabel, isEqualValue, type RecordConflict } from '../utils/merge';
import { uid } from '../utils/id';
import type { FieldOfView, Instrument, Telescope, TelescopeStatus, TerminalType } from '../types';

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

/** 设备记录保存结果：已保存 / 冲突待裁决 */
export type EquipmentSaveOutcome<T> = { status: 'saved'; row: T } | { status: 'conflict'; conflict: RecordConflict };

interface EquipmentState {
  telescopes: Telescope[];
  instruments: Instrument[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTelescope: (input: TelescopeInput) => Promise<Telescope>;
  updateTelescope: (id: string, patch: Partial<TelescopeInput>) => Promise<EquipmentSaveOutcome<Telescope>>;
  removeTelescope: (id: string) => Promise<void>;
  addInstrument: (input: InstrumentInput) => Promise<Instrument>;
  updateInstrument: (id: string, patch: Partial<InstrumentInput>) => Promise<EquipmentSaveOutcome<Instrument>>;
  removeInstrument: (id: string) => Promise<void>;
  /** 冲突裁决后写入用户选定的望远镜记录 */
  resolveTelescopeConflict: (row: Telescope) => Promise<void>;
  /** 冲突裁决后写入用户选定的终端记录 */
  resolveInstrumentConflict: (row: Instrument) => Promise<void>;
  /** 按靶面与焦距换算视场角 */
  fieldOfView: (telescopeId: string, instrumentId: string) => FieldOfView;
}

const RAD = Math.PI / 180;

/** 参与三向合并的望远镜字段 */
const TELESCOPE_FIELDS = ['code', 'apertureMm', 'focalLengthMm', 'mount', 'terminals', 'maxPayloadKg', 'status'] as const;
/** 参与三向合并的终端字段 */
const INSTRUMENT_FIELDS = ['model', 'terminalType', 'pixelSizeUm', 'sensorWidthMm', 'sensorHeightMm', 'readNoiseE', 'telescopeCode'] as const;

/** 通用：更新一条设备记录（望远镜/终端），处理并发冲突 */
async function updateEquipmentRecord<T extends { id: string; rev: number }>(
  table: 'telescopes' | 'instruments',
  id: string,
  patch: Record<string, unknown>,
  fields: readonly string[],
  recordLabel: string,
  rows: T[],
  setRows: (rows: T[]) => void,
): Promise<EquipmentSaveOutcome<T>> {
  const base = rows.find((row) => row.id === id);
  if (!base) return { status: 'saved', row: { id, ...patch } as T };
  const theirs = await db.table(table).get(id);
  const ours = { ...base, ...patch };

  if (!theirs) {
    const changedFields = fields.filter((field) => !isEqualValue(ours[field], (base as Record<string, unknown>)[field]));
    return {
      status: 'conflict',
      conflict: {
        table,
        recordId: id,
        recordLabel,
        fields: changedFields.map((field) => ({
          field,
          label: fieldLabel(field),
          base: (base as Record<string, unknown>)[field],
          ours: ours[field],
          theirs: undefined,
        })),
        ours: ours as Record<string, unknown>,
        theirs: {},
        theirsMissing: true,
      },
    };
  }

  if (theirs.rev === base.rev) {
    const saved = await persistRow<T>(table, ours);
    setRows(rows.map((row) => (row.id === id ? saved : row)));
    return { status: 'saved', row: saved };
  }

  const { merged, conflicts } = threeWayMerge(base, ours, theirs, fields);
  if (conflicts.length > 0) {
    return {
      status: 'conflict',
      conflict: {
        table,
        recordId: id,
        recordLabel,
        fields: conflicts,
        ours: ours as Record<string, unknown>,
        theirs: theirs as Record<string, unknown>,
      },
    };
  }

  const saved = await persistRow<T>(table, merged);
  setRows(rows.map((row) => (row.id === id ? saved : row)));
  return { status: 'saved', row: saved };
}

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
    const telescope: Omit<Telescope, 'rev'> = {
      id: uid('tel'),
      code: input.code.trim(),
      apertureMm: Number(input.apertureMm) || 0,
      focalLengthMm: Number(input.focalLengthMm) || 0,
      mount: input.mount.trim(),
      terminals: input.terminals.length ? input.terminals : ['CMOS 相机'],
      maxPayloadKg: Number(input.maxPayloadKg) || 0,
      status: input.status,
    };
    const saved = await persistRow<Telescope>('telescopes', telescope);
    set({ telescopes: [...get().telescopes, saved].sort((a, b) => a.code.localeCompare(b.code)) });
    return saved;
  },

  updateTelescope: async (id, patch) => {
    const outcome = await updateEquipmentRecord<Telescope>(
      'telescopes',
      id,
      patch as Record<string, unknown>,
      TELESCOPE_FIELDS,
      '望远镜',
      get().telescopes,
      (rows) => set({ telescopes: rows }),
    );
    return outcome;
  },

  removeTelescope: async (id) => {
    await deleteRow('telescopes', id);
    set({ telescopes: get().telescopes.filter((telescope) => telescope.id !== id) });
  },

  addInstrument: async (input) => {
    const instrument: Omit<Instrument, 'rev'> = {
      id: uid('ins'),
      model: input.model.trim(),
      terminalType: input.terminalType,
      pixelSizeUm: Number(input.pixelSizeUm) || 0,
      sensorWidthMm: Number(input.sensorWidthMm) || 0,
      sensorHeightMm: Number(input.sensorHeightMm) || 0,
      readNoiseE: Number(input.readNoiseE) || 0,
      telescopeCode: input.telescopeCode,
    };
    const saved = await persistRow<Instrument>('instruments', instrument);
    set({ instruments: [...get().instruments, saved] });
    return saved;
  },

  updateInstrument: async (id, patch) => {
    const outcome = await updateEquipmentRecord<Instrument>(
      'instruments',
      id,
      patch as Record<string, unknown>,
      INSTRUMENT_FIELDS,
      '终端',
      get().instruments,
      (rows) => set({ instruments: rows }),
    );
    return outcome;
  },

  removeInstrument: async (id) => {
    await deleteRow('instruments', id);
    set({ instruments: get().instruments.filter((instrument) => instrument.id !== id) });
  },

  resolveTelescopeConflict: async (row) => {
    const saved = await persistRow<Telescope>('telescopes', row);
    set({ telescopes: get().telescopes.map((telescope) => (telescope.id === saved.id ? saved : telescope)) });
  },

  resolveInstrumentConflict: async (row) => {
    const saved = await persistRow<Instrument>('instruments', row);
    set({ instruments: get().instruments.map((instrument) => (instrument.id === saved.id ? saved : instrument)) });
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
