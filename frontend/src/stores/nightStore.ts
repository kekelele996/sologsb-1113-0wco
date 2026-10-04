import { create } from 'zustand';
import { db, deleteRow, notifyTablesChanged } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { commitRow, revisionOf } from '../utils/revision';
import type { ObsNight } from '../types';

export interface NightInput {
  date: string;
  siteName: string;
  siteLat: number;
  siteLng: number;
  moonPhasePct: number;
  moonrise: string;
  moonset: string;
  sunset: string;
  sunrise: string;
  cloudText: string;
  primary: boolean;
  backup: boolean;
  dutyOfficer: string;
  remark?: string;
}

interface NightState {
  nights: ObsNight[];
  currentNightId: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setCurrentNight: (id: string) => void;
  addNight: (input: NightInput) => Promise<ObsNight>;
  updateNight: (id: string, patch: Partial<NightInput>) => Promise<void>;
  removeNight: (id: string) => Promise<void>;
}

/** 观测夜与主夜 / 备用夜 */
export const useNightStore = create<NightState>()((set, get) => ({
  nights: [],
  currentNightId: '',
  hydrated: false,

  hydrate: async () => {
    const nights = await db.nights.orderBy('date').toArray();
    const current = get().currentNightId || nights.find((night) => night.primary)?.id || nights[0]?.id || '';
    set({ nights, currentNightId: current, hydrated: true });
  },

  setCurrentNight: (id) => set({ currentNightId: id }),

  addNight: async (input) => {
    const night: ObsNight = {
      id: uid('night'),
      date: input.date,
      siteName: input.siteName.trim(),
      siteLat: Number(input.siteLat) || 0,
      siteLng: Number(input.siteLng) || 0,
      moonPhasePct: Number(input.moonPhasePct) || 0,
      moonrise: input.moonrise,
      moonset: input.moonset,
      sunset: input.sunset,
      sunrise: input.sunrise,
      cloudText: input.cloudText,
      primary: input.primary,
      backup: input.backup,
      dutyOfficer: input.dutyOfficer.trim(),
      remark: input.remark?.trim() || undefined,
      revision: revisionOf(undefined),
    };
    const outcome = await commitRow('nights', night);
    notifyTablesChanged(['nights']);
    const saved = outcome.type === 'saved' ? outcome.row : night;
    set({ nights: [...get().nights, saved].sort((a, b) => a.date.localeCompare(b.date)) });
    return saved;
  },

  updateNight: async (id, patch) => {
    const current = get().nights.find((night) => night.id === id);
    if (!current) return;
    const next: ObsNight = { ...current, ...patch, revision: revisionOf(current) };
    const outcome = await commitRow('nights', next, revisionOf(current));
    notifyTablesChanged(['nights']);
    if (outcome.type === 'saved') {
      set({ nights: get().nights.map((night) => (night.id === id ? outcome.row : night)) });
    }
  },

  removeNight: async (id) => {
    await deleteRow('nights', id);
    set({ nights: get().nights.filter((night) => night.id !== id) });
  },
}));
