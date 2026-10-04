import type { Instrument, ObsSession, ObsTarget, Telescope } from '../types';

/** 字段中文名与取值文案：冲突裁决对话框逐字段摊开差异时使用 */
function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  return String(value);
}

export const SESSION_FIELD_LABELS: Partial<Record<keyof ObsSession, string>> = {
  nightId: '观测夜',
  targetId: '观测目标',
  startTime: '开始时刻',
  endTime: '结束时刻',
  telescopeId: '望远镜',
  instrumentId: '终端',
  filterSlot: '滤镜轮位',
  plannedFrames: '计划帧数',
  status: '状态',
  rescheduleReason: '改期原因',
  backupNightId: '替补夜',
};

export const TELESCOPE_FIELD_LABELS: Partial<Record<keyof Telescope, string>> = {
  code: '编号',
  apertureMm: '口径(mm)',
  focalLengthMm: '焦距(mm)',
  mount: '赤道仪',
  terminals: '可用终端',
  maxPayloadKg: '最大载荷(kg)',
  status: '状态',
};

export const INSTRUMENT_FIELD_LABELS: Partial<Record<keyof Instrument, string>> = {
  model: '型号',
  terminalType: '类型',
  pixelSizeUm: '像元(μm)',
  sensorWidthMm: '靶面宽(mm)',
  sensorHeightMm: '靶面高(mm)',
  readNoiseE: '读出噪声(e-)',
  telescopeCode: '适配望远镜',
};

export const TARGET_FIELD_LABELS: Partial<Record<keyof ObsTarget, string>> = {
  name: '目标名',
  catalog: '星表编号',
  raHours: '赤经(h)',
  decDeg: '赤纬(°)',
  magnitude: '视星等',
  type: '类型',
  filter: '推荐滤镜',
  exposureSec: '单帧曝光(s)',
  totalMinutes: '建议累计(min)',
  priority: '优先级',
  minAltitude: '高度阈值(°)',
  remark: '备注',
};

/** 外键 id 转可读文案的格式化器（裁决对话框按实体注入） */
export function sessionFieldFormatter(context: {
  nights: { id: string; date: string; primary?: boolean; backup?: boolean }[];
  targets: { id: string; name: string }[];
  telescopes: { id: string; code: string; status: string }[];
  instruments: { id: string; model: string }[];
}): (field: string, value: unknown) => string {
  const night = (id: unknown) => {
    const item = context.nights.find((night) => night.id === id);
    if (!item) return text(id);
    return `${item.date}${item.primary ? '（主夜）' : item.backup ? '（备用夜）' : ''}`;
  };
  return (field, value) => {
    if (field === 'nightId') return night(value);
    if (field === 'backupNightId') return value ? night(value) : '（无）';
    if (field === 'targetId') return context.targets.find((target) => target.id === value)?.name ?? text(value);
    if (field === 'telescopeId') {
      const telescope = context.telescopes.find((item) => item.id === value);
      return telescope ? `${telescope.code}（${telescope.status}）` : text(value);
    }
    if (field === 'instrumentId') return context.instruments.find((item) => item.id === value)?.model ?? text(value);
    return text(value);
  };
}

export const telescopeFieldFormatter = (): ((field: string, value: unknown) => string) => (_field, value) => text(value);

export const instrumentFieldFormatter = (telescopes: Telescope[]): ((field: string, value: unknown) => string) => {
  return (field, value) => {
    if (field === 'telescopeCode') {
      const telescope = telescopes.find((item) => item.code === value);
      return telescope ? `${telescope.code}（${telescope.status}）` : text(value);
    }
    return text(value);
  };
};

export const targetFieldFormatter = (): ((field: string, value: unknown) => string) => (_field, value) => text(value);
