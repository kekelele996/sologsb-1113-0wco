import { db, type TableName } from '../hooks/usePersistentStore';
import { INITIAL_REVISION, type CommitOutcome, type FieldDiff, type VersionedRow } from '../types';

/** 取记录的改动序号，旧数据（v3 升级前）没有序号时按起始值算，不算冲突 */
export function revisionOf(row: Partial<VersionedRow> | null | undefined): number {
  const revision = row?.revision;
  return typeof revision === 'number' && Number.isFinite(revision) && revision > 0 ? revision : INITIAL_REVISION;
}

/** 稳定序列化：忽略键顺序，数组保持原顺序，undefined 与缺省键一致 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 比较两个字段值（容忍 1 与 '1' 这类表单数字 / 字符串差异之外的严格差异） */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * 比较两条记录的业务内容是否一致：
 * revision 是并发簿记字段，不参与内容比较（序号对齐但内容没变的保存不算一次改动）。
 */
export function sameContent(a: object, b: object): boolean {
  const strip = (row: object) => {
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'revision') continue;
      if (value !== undefined) copy[key] = value;
    }
    return copy;
  };
  return stableJson(strip(a)) === stableJson(strip(b));
}

const RESERVED_KEYS = new Set(['id', 'revision']);

/**
 * 找出真正取值不同的字段（两边都动过且结果不一致才算）：
 * - 只有一方改了（另一方与基线相同）→ 自动并入，不进差异；
 * - id / revision 不参与。
 */
export function differingFields(current: VersionedRow, attempted: VersionedRow): string[] {
  const currentRecord = current as unknown as Record<string, unknown>;
  const attemptedRecord = attempted as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(currentRecord), ...Object.keys(attemptedRecord)]);
  const fields: string[] = [];
  keys.forEach((key) => {
    if (RESERVED_KEYS.has(key)) return;
    if (!sameFieldValue(currentRecord[key], attemptedRecord[key])) fields.push(key);
  });
  return fields;
}

export function buildDiffs<T extends VersionedRow>(
  current: T,
  attempted: T,
  labels: Partial<Record<string, string>>,
): FieldDiff[] {
  return differingFields(current, attempted).map((field) => ({
    field,
    label: labels[field] ?? field,
    mine: (attempted as unknown as Record<string, unknown>)[field],
    theirs: (current as unknown as Record<string, unknown>)[field],
  }));
}

/**
 * 按字段裁决结果合并出最终记录：以库里最新记录为底，逐字段采用 mine/theirs。
 * id 始终以库里的当前记录为准。
 */
export function mergeByFields<T extends VersionedRow>(
  current: T,
  attempted: T,
  sideByField: Record<string, 'mine' | 'theirs'>,
): T {
  const merged: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>), id: current.id };
  Object.entries(sideByField).forEach(([field, side]) => {
    const source = (side === 'mine' ? attempted : current) as unknown as Record<string, unknown>;
    merged[field] = source[field];
  });
  return merged as T;
}

/**
 * 乐观锁保存（五张表通用）：
 * - expectedRevision 缺省 → 新增（库中已存在同 id 时仍按序号校验）；
 * - 库里序号与期望一致：内容没变则只做序号对齐返回 unchanged，内容变了则 revision+1 落库；
 * - 序号对不上（另一边先存过）：返回 conflict，由调用方摊开字段差异让人裁决，绝不覆盖。
 */
export async function commitRow<T extends VersionedRow>(
  table: TableName,
  attempted: T,
  expectedRevision?: number,
): Promise<CommitOutcome<T>> {
  return db.transaction('rw', db.table(table), async () => {
    const stored = (await db.table(table).get(attempted.id)) as T | undefined;
    if (stored) {
      const storedRevision = revisionOf(stored);
      if (typeof expectedRevision === 'number' && expectedRevision !== storedRevision) {
        return { type: 'conflict', current: stored, attempted, diffs: [] } as CommitOutcome<T>;
      }
      if (sameContent(stored, attempted)) {
        return { type: 'saved', row: stored, unchanged: true };
      }
      const saved: T = { ...attempted, revision: storedRevision + 1 };
      await db.table(table).put(saved as never);
      return { type: 'saved', row: saved, unchanged: false };
    }
    const created: T = { ...attempted, revision: INITIAL_REVISION };
    await db.table(table).put(created as never);
    return { type: 'saved', row: created, unchanged: false };
  });
}
