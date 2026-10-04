/**
 * 乐观并发控制（OCC）的公共类型
 *
 * 同一条记录可能同时被两个页签（设备分配视图 / 排程段列表）修改，
 * 每条记录带一个单调递增的「改动序号」revision：保存时必须带上打开记录时看到的序号，
 * 库里的序号对不上即说明期间已被另一边改动过，进入字段级差异裁决，而不是后写覆盖先写。
 */

/** 起始改动序号：v3 升级时给没有序号的旧数据补这个值；新记录也从它起算 */
export const INITIAL_REVISION = 1;

/** 所有参与乐观锁的记录都带改动序号 */
export interface VersionedRow {
  id: string;
  /** 改动序号：每次内容真正发生变化时 +1 */
  revision: number;
}

/** 单个字段的差异（同一字段两边都动过） */
export interface FieldDiff<K extends string = string> {
  field: K;
  /** 字段中文名（裁决对话框表头） */
  label: string;
  /** 本次提交方的值（当前页签里填的） */
  mine: unknown;
  /** 库里已被另一边先存下的值 */
  theirs: unknown;
}

/** 提交（保存）结果的判别联合 */
export type CommitOutcome<T> =
  | { type: 'saved'; row: T; /** 是否仅为序号对齐而未落内容（内容没真变） */ unchanged: boolean }
  | {
      type: 'conflict';
      /** 库里另一边刚存下的最新记录 */
      current: T;
      /** 本次想写入的记录（base + 本页签改动） */
      attempted: T;
      /** 实际取值不同的字段（没动过的字段不算冲突） */
      diffs: FieldDiff[];
    };

/** CommitOutcome 的冲突分支（供保存结果的嵌套类型精确收窄） */
export type CommitConflict<T> = Extract<CommitOutcome<T>, { type: 'conflict' }>;

/** 排程侧保存时，设备侧望远镜已变为不可用状态而被退回 */
export interface StaleTelescopeBlock {
  telescopeId: string;
  telescopeCode: string;
  /** 设备侧当前状态（维护中 / 外出） */
  currentStatus: string;
  /** 本页签开始编辑该段时看到的旧状态 */
  seenStatus: string;
}
