/**
 * 三向合并（3-way merge）工具：
 * 纯前端应用没有后端，两个页签共享同一个 IndexedDB，后保存的页签会覆盖先保存页签的改动。
 * 保存前用「本页签加载值 base / 本页签新值 ours / 数据库当前值 theirs」逐字段比对：
 * - 两边都改了同一字段且不一致 → 冲突，交给用户摊开差异定用哪边；
 * - 只有一边改了 → 采用那一边的值；
 * - 两边都没改 → 保持原值。
 */

/** 字段冲突：同一条记录的同一字段被两个页签改成了不同的值 */
export interface FieldConflict {
  /** 字段名 */
  field: string;
  /** 中文字段名（用于展示） */
  label: string;
  /** 本页签加载时的值 */
  base: unknown;
  /** 本页签要写入的值 */
  ours: unknown;
  /** 对方页签已写入的值 */
  theirs: unknown;
}

/** 记录级冲突：同一条记录被两个页签同时改动 */
export interface RecordConflict {
  table: TableNameLike;
  recordId: string;
  /** 记录类型中文名（如「排程段」「望远镜」） */
  recordLabel: string;
  /** 冲突字段列表（两边都改了且不一致的字段） */
  fields: FieldConflict[];
  /** 本页签要写入的完整记录 */
  ours: Record<string, unknown>;
  /** 数据库当前（对方页签写入）的完整记录 */
  theirs: Record<string, unknown>;
  /** 对方页签已删除该记录 */
  theirsMissing?: boolean;
}

/** 表名（与 usePersistentStore 的 TableName 对应，避免循环依赖） */
export type TableNameLike = 'targets' | 'sessions' | 'telescopes' | 'instruments' | 'nights';

/** 字段中文名映射 */
const FIELD_LABELS: Record<string, string> = {
  // 排程段
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
  needsReschedule: '退回重排',
  // 望远镜
  code: '编号',
  apertureMm: '口径',
  focalLengthMm: '焦距',
  mount: '赤道仪',
  terminals: '可用终端',
  maxPayloadKg: '最大载荷',
  // 终端
  model: '型号',
  terminalType: '类型',
  pixelSizeUm: '像元尺寸',
  sensorWidthMm: '靶面宽',
  sensorHeightMm: '靶面高',
  readNoiseE: '读出噪声',
  telescopeCode: '适配望远镜',
  // 观测夜
  date: '日期',
  siteName: '站点名',
  siteLat: '站点纬度',
  siteLng: '站点经度',
  moonPhasePct: '月相百分比',
  moonrise: '月出时刻',
  moonset: '月落时刻',
  sunset: '日落时刻',
  sunrise: '日出时刻',
  cloudText: '云量',
  primary: '主夜',
  backup: '备用夜',
  dutyOfficer: '值班人',
  remark: '备注',
  // 目标
  name: '名称',
  catalog: '星表编号',
  raHours: '赤经',
  decDeg: '赤纬',
  magnitude: '视星等',
  type: '目标类型',
  filter: '推荐滤镜',
  exposureSec: '曝光秒数',
  totalMinutes: '建议累计时长',
  priority: '优先级',
  minAltitude: '最小地平高度阈值',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** 深度相等（支持数组，如 terminals） */
export function isEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => isEqualValue(value, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return aKeys.length === bKeys.length && aKeys.every((key) => isEqualValue(aRecord[key], bRecord[key]));
  }
  return false;
}

/** 把字段值格式化成可展示文本 */
export function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '（空）';
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (field === 'status' && typeof value === 'string') return value;
  return String(value);
}

export interface MergeResult<T> {
  /** 合并后的记录（冲突字段默认取对方值，待用户在对话框中选择） */
  merged: T;
  /** 两边都改了且不一致的字段 */
  conflicts: FieldConflict[];
}

/**
 * 三向合并单条记录。
 * @param base 本页签上次加载/保存时的值
 * @param ours 本页签要写入的值
 * @param theirs 数据库当前值（对方页签已写入）
 * @param fields 需要参与合并的字段名
 */
export function threeWayMerge<T extends { id: string }>(base: T, ours: T, theirs: T, fields: readonly string[]): MergeResult<T> {
  const conflicts: FieldConflict[] = [];
  const merged: Record<string, unknown> = { ...(theirs as Record<string, unknown>) };
  const baseRecord = base as Record<string, unknown>;
  const oursRecord = ours as Record<string, unknown>;
  const theirsRecord = theirs as Record<string, unknown>;

  for (const field of fields) {
    const baseValue = baseRecord[field];
    const oursValue = oursRecord[field];
    const theirsValue = theirsRecord[field];
    const changedByUs = !isEqualValue(oursValue, baseValue);
    const changedByThem = !isEqualValue(theirsValue, baseValue);
    if (changedByUs && changedByThem && !isEqualValue(oursValue, theirsValue)) {
      // 两边都改了同一字段且不一致 → 冲突，默认保留对方值待用户选择
      conflicts.push({ field, label: fieldLabel(field), base: baseValue, ours: oursValue, theirs: theirsValue });
      merged[field] = theirsValue;
    } else if (changedByUs && !changedByThem) {
      // 只有我方改了 → 采用我方
      merged[field] = oursValue;
    } else {
      // 对方改了（采用对方）或两边都没改（保持对方/原值）
      merged[field] = theirsValue;
    }
  }

  return { merged: merged as T, conflicts };
}
