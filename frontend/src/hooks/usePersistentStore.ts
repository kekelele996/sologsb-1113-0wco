import Dexie, { type Table } from 'dexie';
import { useEffect, useState } from 'react';
import { INITIAL_REVISION, type VersionedRow } from '../types';
import type { Instrument, ObsNight, ObsSession, ObsTarget, Telescope } from '../types';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbobsplan-db';

/** 当前数据结构版本，写入每条记录并用于升级迁移判定 */
export const SCHEMA_VERSION = 3;

class ObsPlanDB extends Dexie {
  targets!: Table<ObsTarget, string>;
  sessions!: Table<ObsSession, string>;
  telescopes!: Table<Telescope, string>;
  instruments!: Table<Instrument, string>;
  nights!: Table<ObsNight, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      targets: 'id, name, catalog, type, priority, magnitude',
      sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status',
      telescopes: 'id, code, status',
      instruments: 'id, model, telescopeCode, terminalType',
      nights: 'id, date, siteName, primary, backup',
      meta: 'key',
    });

    // v2：排程段增加 backupNightId 索引；旧版本数据升级时补齐 backupNightId 与 schemaVersion
    // （因云取消且未指定替补夜的排程段，自动挂到最近的备用观测夜）
    this.version(2)
      .stores({
        targets: 'id, name, catalog, type, priority, magnitude',
        sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId',
        telescopes: 'id, code, status',
        instruments: 'id, model, telescopeCode, terminalType',
        nights: 'id, date, siteName, primary, backup',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const nights = (await tx.table('nights').toArray()) as ObsNight[];
        const backupNight = nights.find((night) => night.backup);
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: ObsSession) => {
            if (row.schemaVersion !== SCHEMA_VERSION) {
              row.schemaVersion = SCHEMA_VERSION;
            }
            if (!row.backupNightId && row.status === '因云取消' && backupNight) {
              row.backupNightId = backupNight.id;
            }
          });
      });

    // v3：全部记录增加改动序号 revision（乐观锁）。
    // 旧数据没有序号，升级时一律按现有内容补起始值；没动过的记录 revision 相同，不算冲突。
    this.version(3)
      .stores({
        targets: 'id, name, catalog, type, priority, magnitude',
        sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId',
        telescopes: 'id, code, status',
        instruments: 'id, model, telescopeCode, terminalType',
        nights: 'id, date, siteName, primary, backup',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const backfill = async (tableName: string) => {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: VersionedRow) => {
              if (typeof row.revision !== 'number' || !(row.revision > 0)) {
                row.revision = INITIAL_REVISION;
              }
            });
        };
        await backfill('targets');
        await backfill('telescopes');
        await backfill('instruments');
        await backfill('nights');
        await backfill('sessions');
        await tx
          .table('sessions')
          .toCollection()
          .modify((row: ObsSession) => {
            row.schemaVersion = SCHEMA_VERSION;
          });
      });
  }
}

export const db = new ObsPlanDB();

export type TableName = 'targets' | 'sessions' | 'telescopes' | 'instruments' | 'nights';

/** 写入单条记录（Dexie 读写封装，不做并发校验的场景使用） */
export async function persistRow(table: TableName, row: unknown): Promise<void> {
  await db.table(table).put(row as never);
  notifyTablesChanged([table]);
}

/** 批量写入 */
export async function persistRows(table: TableName, rows: unknown[]): Promise<void> {
  await db.table(table).bulkPut(rows as never[]);
  notifyTablesChanged([table]);
}

/** 删除记录 */
export async function deleteRow(table: TableName, id: string): Promise<void> {
  await db.table(table).delete(id);
  notifyTablesChanged([table]);
}

/* --------------------------- 跨页签数据变更同步 -------------------------- */

const CHANNEL_KEY = 'gbobsplan-db-changes';
const STORAGE_FALLBACK_KEY = 'gbobsplan:db-changes';

type ChangeMessage = { tables: TableName[]; at: number };

let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_KEY);
}

/** 提交落库后通知其他页签：对应 store 需要重新灌水，总览 / 时间轴随之刷新 */
export function notifyTablesChanged(tables: TableName[]): void {
  if (tables.length === 0) return;
  const message: ChangeMessage = { tables, at: Date.now() };
  if (channel) {
    channel.postMessage(message);
  } else if (typeof localStorage !== 'undefined') {
    // 兜底：不支持 BroadcastChannel 的环境用 storage 事件（本页签不会收到自己写的值）
    localStorage.setItem(STORAGE_FALLBACK_KEY, JSON.stringify(message));
  }
}

type TableListener = (tables: TableName[]) => void;
const listeners = new Set<TableListener>();

/** 订阅其他页签的落库变更（只通知，不回放数据；数据统一从 IndexedDB 重新读取） */
export function subscribeExternalChanges(listener: TableListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  channel?.addEventListener('message', (event: MessageEvent<ChangeMessage>) => {
    if (event.data?.tables) listeners.forEach((listener) => listener(event.data.tables));
  });
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_FALLBACK_KEY && event.newValue) {
      try {
        const message = JSON.parse(event.newValue) as ChangeMessage;
        if (message.tables) listeners.forEach((listener) => listener(message.tables));
      } catch {
        /* 忽略无法解析的兜底消息 */
      }
    }
  });

  // 另一个页签打开了更高版本的数据库（触发 v3 迁移）时，本页签会被阻塞升级，直接重载拿新结构
  db.on('versionchange', () => {
    window.location.reload();
  });
}

/* ------------------------------- 示例数据 ------------------------------- */

const SEED_TARGETS: Array<Omit<ObsTarget, 'revision'>> = [
  { id: 'target-001', name: 'M31', catalog: 'NGC 224', raHours: 0.712, decDeg: 41.27, magnitude: 3.4, type: '星系', filter: 'L', exposureSec: 120, totalMinutes: 90, priority: 'P1', minAltitude: 25, remark: '仙女座大星系，需大视场' },
  { id: 'target-002', name: 'M42', catalog: 'NGC 1976', raHours: 5.588, decDeg: -5.39, magnitude: 4, type: '星云', filter: 'L', exposureSec: 60, totalMinutes: 60, priority: 'P1', minAltitude: 20, remark: '猎户座大星云，核心易过曝' },
  { id: 'target-003', name: 'M45', catalog: 'Mel 27', raHours: 3.79, decDeg: 24.11, magnitude: 1.6, type: '疏散星团', filter: '无滤镜', exposureSec: 30, totalMinutes: 30, priority: 'P2', minAltitude: 25 },
  { id: 'target-004', name: 'NGC 7000', catalog: 'C20', raHours: 20.98, decDeg: 44.52, magnitude: 4, type: '星云', filter: 'Ha', exposureSec: 300, totalMinutes: 180, priority: 'P1', minAltitude: 35, remark: '北美洲星云，窄带优先' },
  { id: 'target-005', name: 'NGC 869', catalog: 'C14', raHours: 2.32, decDeg: 57.13, magnitude: 4.3, type: '疏散星团', filter: 'L', exposureSec: 60, totalMinutes: 45, priority: 'P2', minAltitude: 30, remark: '英仙双星团之一' },
  { id: 'target-006', name: 'M13', catalog: 'NGC 6205', raHours: 16.695, decDeg: 36.46, magnitude: 5.8, type: '疏散星团', filter: 'L', exposureSec: 90, totalMinutes: 60, priority: 'P2', minAltitude: 30, remark: '球状星团，暂归入星团类统计' },
  { id: 'target-007', name: 'M51', catalog: 'NGC 5194', raHours: 13.498, decDeg: 47.2, magnitude: 8.4, type: '星系', filter: 'L', exposureSec: 180, totalMinutes: 120, priority: 'P2', minAltitude: 40, remark: '涡状星系，暗目标' },
  { id: 'target-008', name: 'NGC 2237', catalog: 'C49', raHours: 6.52, decDeg: 4.95, magnitude: 9, type: '星云', filter: 'Ha', exposureSec: 300, totalMinutes: 150, priority: 'P2', minAltitude: 30, remark: '玫瑰星云' },
  { id: 'target-009', name: 'M27', catalog: 'NGC 6853', raHours: 19.99, decDeg: 22.72, magnitude: 7.4, type: '星云', filter: 'OIII', exposureSec: 180, totalMinutes: 90, priority: 'P2', minAltitude: 30, remark: '哑铃星云' },
  { id: 'target-010', name: '木星', catalog: 'Jupiter', raHours: 2.5, decDeg: 12.5, magnitude: -2.2, type: '行星', filter: '无滤镜', exposureSec: 0.02, totalMinutes: 20, priority: 'P1', minAltitude: 20, remark: '行星视频叠加' },
  { id: 'target-011', name: '月面', catalog: 'Moon', raHours: 0, decDeg: 0, magnitude: -12.7, type: '月面', filter: '无滤镜', exposureSec: 0.005, totalMinutes: 15, priority: 'P1', minAltitude: 15, remark: '月面细节拼接' },
  { id: 'target-012', name: 'IC 1396', catalog: 'C33', raHours: 21.65, decDeg: 57.5, magnitude: 3.5, type: '星云', filter: 'SII', exposureSec: 300, totalMinutes: 180, priority: 'P3', minAltitude: 40, remark: '象鼻星云' },
];

const SEED_NIGHTS: Array<Omit<ObsNight, 'revision'>> = [
  { id: 'night-001', date: '2025-10-11', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 18, moonrise: '08:40', moonset: '19:05', sunset: '17:42', sunrise: '05:26', cloudText: '晴', primary: true, backup: false, dutyOfficer: '林一舟' },
  { id: 'night-002', date: '2025-10-12', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 26, moonrise: '09:35', moonset: '19:40', sunset: '17:41', sunrise: '05:27', cloudText: '少云', primary: true, backup: false, dutyOfficer: '林一舟' },
  { id: 'night-003', date: '2025-10-13', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 35, moonrise: '10:32', moonset: '20:18', sunset: '17:39', sunrise: '05:28', cloudText: '多云', primary: false, backup: true, dutyOfficer: '沈知远', remark: '备用观测夜' },
  { id: 'night-004', date: '2025-10-14', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 45, moonrise: '11:30', moonset: '21:00', sunset: '17:38', sunrise: '05:29', cloudText: '晴', primary: false, backup: true, dutyOfficer: '沈知远', remark: '备用观测夜' },
  { id: 'night-005', date: '2025-10-15', siteName: '兴隆观测站', siteLat: 40.3958, siteLng: 117.5772, moonPhasePct: 55, moonrise: '12:28', moonset: '21:46', sunset: '17:36', sunrise: '05:30', cloudText: '有雨', primary: false, backup: true, dutyOfficer: '苏晚', remark: '预报有雨，预留备用' },
];

const SEED_TELESCOPES: Array<Omit<Telescope, 'revision'>> = [
  { id: 'tel-001', code: 'T-01', apertureMm: 150, focalLengthMm: 900, mount: 'EQ6-R Pro', terminals: ['CMOS 相机', '导星相机'], maxPayloadKg: 12, status: '可用' },
  { id: 'tel-002', code: 'T-02', apertureMm: 200, focalLengthMm: 1000, mount: 'CEM70', terminals: ['CMOS 相机', '导星相机', '光谱仪'], maxPayloadKg: 15, status: '可用' },
  { id: 'tel-003', code: 'T-03', apertureMm: 280, focalLengthMm: 2800, mount: 'CEM120', terminals: ['CMOS 相机', '光谱仪'], maxPayloadKg: 25, status: '维护中', },
  { id: 'tel-004', code: 'T-04', apertureMm: 80, focalLengthMm: 480, mount: 'Star Adventurer GTi', terminals: ['导星相机'], maxPayloadKg: 5, status: '外出' },
];

const SEED_INSTRUMENTS: Array<Omit<Instrument, 'revision'>> = [
  { id: 'ins-001', model: 'ASI2600MC Pro', terminalType: 'CMOS 相机', pixelSizeUm: 3.76, sensorWidthMm: 23.5, sensorHeightMm: 15.7, readNoiseE: 1.2, telescopeCode: 'T-02' },
  { id: 'ins-002', model: 'ASI294MC Pro', terminalType: 'CMOS 相机', pixelSizeUm: 4.63, sensorWidthMm: 19.1, sensorHeightMm: 13, readNoiseE: 1.4, telescopeCode: 'T-01' },
  { id: 'ins-003', model: 'ASI174MM Mini', terminalType: '导星相机', pixelSizeUm: 5.86, sensorWidthMm: 11.3, sensorHeightMm: 7.1, readNoiseE: 3.5, telescopeCode: 'T-01' },
  { id: 'ins-004', model: 'Shelyak Lhires III', terminalType: '光谱仪', pixelSizeUm: 9, sensorWidthMm: 8, sensorHeightMm: 6, readNoiseE: 4, telescopeCode: 'T-03' },
];

/** 含一处同望远镜时段冲突（s-03 与 s-04 在 T-02 上重叠）与一条因云取消已改期记录 */
const SEED_SESSIONS: Array<Omit<ObsSession, 'revision'>> = [
  { id: 's-01', nightId: 'night-001', targetId: 'target-001', startTime: '18:20', endTime: '19:20', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 40, status: '已完成', schemaVersion: SCHEMA_VERSION },
  { id: 's-02', nightId: 'night-001', targetId: 'target-002', startTime: '19:30', endTime: '20:30', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'L', plannedFrames: 45, status: '已完成', schemaVersion: SCHEMA_VERSION },
  { id: 's-03', nightId: 'night-001', targetId: 'target-004', startTime: '20:40', endTime: '22:10', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'Ha', plannedFrames: 30, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-04', nightId: 'night-001', targetId: 'target-007', startTime: '21:30', endTime: '23:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 35, status: '待执行', schemaVersion: SCHEMA_VERSION, rescheduleReason: '与窄带目标争用 T-02，待改期' },
  { id: 's-05', nightId: 'night-001', targetId: 'target-009', startTime: '23:10', endTime: '00:20', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'OIII', plannedFrames: 28, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-06', nightId: 'night-001', targetId: 'target-008', startTime: '00:30', endTime: '02:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'Ha', plannedFrames: 30, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-07', nightId: 'night-001', targetId: 'target-011', startTime: '02:10', endTime: '03:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 120, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-08', nightId: 'night-001', targetId: 'target-010', startTime: '03:10', endTime: '04:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: '无滤镜', plannedFrames: 300, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-09', nightId: 'night-002', targetId: 'target-003', startTime: '18:30', endTime: '19:40', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 40, status: '已完成', schemaVersion: SCHEMA_VERSION },
  { id: 's-10', nightId: 'night-002', targetId: 'target-005', startTime: '19:50', endTime: '21:40', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'L', plannedFrames: 50, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-11', nightId: 'night-002', targetId: 'target-004', startTime: '21:50', endTime: '23:30', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'Ha', plannedFrames: 30, status: '因云取消', schemaVersion: SCHEMA_VERSION, rescheduleReason: '夜间云量转多云，目标被云遮挡，改期至备用夜', backupNightId: 'night-003' },
  { id: 's-12', nightId: 'night-002', targetId: 'target-012', startTime: '23:40', endTime: '01:00', telescopeId: 'tel-002', instrumentId: 'ins-001', filterSlot: 'SII', plannedFrames: 30, status: '待执行', schemaVersion: SCHEMA_VERSION, rescheduleReason: '目标地平高度偏低，视情况顺延' },
  { id: 's-13', nightId: 'night-002', targetId: 'target-010', startTime: '01:10', endTime: '02:00', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: '无滤镜', plannedFrames: 240, status: '待执行', schemaVersion: SCHEMA_VERSION },
  { id: 's-14', nightId: 'night-002', targetId: 'target-001', startTime: '02:10', endTime: '03:10', telescopeId: 'tel-001', instrumentId: 'ins-002', filterSlot: 'L', plannedFrames: 30, status: '待执行', schemaVersion: SCHEMA_VERSION },
];

/** 示例数据统一带上起始改动序号 */
function withRevision<T extends { id: string }>(rows: T[]): Array<T & VersionedRow> {
  return rows.map((row) => ({ ...row, revision: INITIAL_REVISION })) as Array<T & VersionedRow>;
}

/** 首次打开（表内无数据）时写入示例数据 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) return;
  const [targetCount, sessionCount, telescopeCount, instrumentCount, nightCount] = await Promise.all([
    db.targets.count(),
    db.sessions.count(),
    db.telescopes.count(),
    db.instruments.count(),
    db.nights.count(),
  ]);
  // Dexie 的 transaction 最多接受 5 张表 + 作用域，因此 meta 标记在事务外写入
  await db.transaction('rw', db.targets, db.sessions, db.telescopes, db.instruments, db.nights, async () => {
    if (targetCount === 0) await db.targets.bulkPut(withRevision(SEED_TARGETS));
    if (nightCount === 0) await db.nights.bulkPut(withRevision(SEED_NIGHTS));
    if (telescopeCount === 0) await db.telescopes.bulkPut(withRevision(SEED_TELESCOPES));
    if (instrumentCount === 0) await db.instruments.bulkPut(withRevision(SEED_INSTRUMENTS));
    if (sessionCount === 0) await db.sessions.bulkPut(withRevision(SEED_SESSIONS));
  });
  await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
}

/** 把 Dexie 数据同步到各 Zustand store（动态 import 规避模块循环依赖） */
export async function hydrateAllStores(): Promise<void> {
  const [{ useTargetStore }, { useSessionStore }, { useEquipmentStore }, { useNightStore }] = await Promise.all([
    import('../stores/targetStore'),
    import('../stores/sessionStore'),
    import('../stores/equipmentStore'),
    import('../stores/nightStore'),
  ]);
  await Promise.all([
    useTargetStore.getState().hydrate(),
    useSessionStore.getState().hydrate(),
    useEquipmentStore.getState().hydrate(),
    useNightStore.getState().hydrate(),
  ]);
}

let bootstrap: Promise<void> | null = null;
let syncSubscribed = false;

/** 收到其他页签的落库通知后，只重新灌水受影响的 store（短延迟合并连续写入） */
function subscribeStoreSync(): () => void {
  const pending = new Set<TableName>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    timer = null;
    const tables = Array.from(pending);
    pending.clear();
    const [targetMod, sessionMod, equipmentMod, nightMod] = await Promise.all([
      import('../stores/targetStore'),
      import('../stores/sessionStore'),
      import('../stores/equipmentStore'),
      import('../stores/nightStore'),
    ]);
    if (tables.includes('targets')) void targetMod.useTargetStore.getState().hydrate();
    if (tables.includes('sessions')) void sessionMod.useSessionStore.getState().hydrate();
    if (tables.includes('telescopes') || tables.includes('instruments')) void equipmentMod.useEquipmentStore.getState().hydrate();
    if (tables.includes('nights')) void nightMod.useNightStore.getState().hydrate();
  };

  return subscribeExternalChanges((tables) => {
    tables.forEach((table) => pending.add(table));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 150);
  });
}

/**
 * 封装 Dexie 表读写与 Zustand 同步：首次调用时打开数据库、写入示例数据并把表数据灌入 store，
 * 各页面用它判断数据是否就绪（多次调用复用同一 bootstrap，不重复装载）。
 */
export function usePersistentStore(): { ready: boolean; error: string } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (!syncSubscribed) {
      subscribeStoreSync();
      syncSubscribed = true;
    }
    if (!bootstrap) {
      bootstrap = (async () => {
        await db.open();
        await seedIfEmpty();
        await hydrateAllStores();
      })();
    }
    bootstrap
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError((reason as Error).message);
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, error };
}
