import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Radio from '@mui/material/Radio';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { FieldDiff, VersionedRow } from '../../types';
import { buildDiffs } from '../../utils/revision';

export interface RevisionConflictDialogProps<T extends VersionedRow> {
  open: boolean;
  /** 库里另一边先存下的记录 */
  current: T | null;
  /** 本次想写入的记录 */
  attempted: T | null;
  /** 字段中文名（缺省用字段键名） */
  labels?: Partial<Record<string, string>>;
  /** 取值格式化（外键 id → 可读文案） */
  formatValue?: (field: string, value: unknown) => string;
  /** 顶部说明（谁在和谁冲突） */
  description?: string;
  /** 提交裁决结果；返回 false 表示落库期间记录又变了，对话框按新 current 保持打开 */
  onResolve: (sideByField: Record<string, 'mine' | 'theirs'>) => Promise<boolean>;
  onClose: () => void;
}

/**
 * 同一条记录被两边都动过时摊开的字段级裁决对话框：
 * - 没碰上的字段不出现（只有取值真的不一致的字段才列出）；
 * - 每个字段单独选「用我填的 / 用对方先存的」，也可整行一键采用某一边；
 * - 确认后按字段合并，两边改动都留得住。
 */
export default function RevisionConflictDialog<T extends VersionedRow>({
  open,
  current,
  attempted,
  labels,
  formatValue,
  description,
  onResolve,
  onClose,
}: RevisionConflictDialogProps<T>) {
  const diffs: FieldDiff[] = useMemo(
    () => (current && attempted ? buildDiffs(current, attempted, labels ?? {}) : []),
    [current, attempted, labels],
  );
  const [sideByField, setSideByField] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [submitting, setSubmitting] = useState(false);

  // current/attempted 切换（新的冲突进入）时重置选择，默认每个字段采用对方已存值
  useEffect(() => {
    const initial: Record<string, 'mine' | 'theirs'> = {};
    diffs.forEach((diff) => {
      initial[diff.field] = 'theirs';
    });
    setSideByField(initial);
  }, [diffs]);

  if (!current || !attempted) return null;

  const format = (field: string, value: unknown) =>
    formatValue ? formatValue(field, value) : value === undefined || value === null || value === '' ? '（空）' : String(value);

  const chooseAll = (side: 'mine' | 'theirs') => {
    const next: Record<string, 'mine' | 'theirs'> = {};
    diffs.forEach((diff) => {
      next[diff.field] = side;
    });
    setSideByField(next);
  };

  async function confirm() {
    setSubmitting(true);
    try {
      const ok = await onResolve(sideByField);
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>该记录已被另一页签改动，请逐字段定夺保留哪边</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          {description ?? '同一记录两边都保存过。未改动的字段已自动保留，下列字段两边的取值不一致，请为每个字段选择最终内容。'}
        </Alert>
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <Button size="small" variant="outlined" onClick={() => chooseAll('mine')}>
            全部用我填的
          </Button>
          <Button size="small" variant="outlined" onClick={() => chooseAll('theirs')}>
            全部用对方已存的
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
            记录 {current.id} · 对方改动序号 {current.revision}
          </Typography>
        </Stack>
        <Table size="small" sx={{ border: '1px solid', borderColor: 'divider' }}>
          <TableHead>
            <TableRow>
              <TableCell>字段</TableCell>
              <TableCell>我填的（本页签）</TableCell>
              <TableCell align="center" sx={{ width: 64 }}>
                采用
              </TableCell>
              <TableCell>对方已存的（另一页签）</TableCell>
              <TableCell align="center" sx={{ width: 64 }}>
                采用
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {diffs.map((diff) => {
              const side = sideByField[diff.field] ?? 'theirs';
              const mineText = format(diff.field, diff.mine);
              const theirsText = format(diff.field, diff.theirs);
              return (
                <TableRow key={diff.field} hover>
                  <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{diff.label}</TableCell>
                  <TableCell
                    onClick={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'mine' }))}
                    sx={{
                      cursor: 'pointer',
                      bgcolor: side === 'mine' ? 'rgba(74,92,196,.10)' : undefined,
                      border: side === 'mine' ? '2px solid #4a5cc4' : '2px solid transparent',
                      maxWidth: 260,
                    }}
                  >
                    <Stack direction="row" spacing={0.5} alignItems="flex-start">
                      <Radio size="small" checked={side === 'mine'} onChange={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'mine' }))} />
                      <Typography variant="body2">{mineText}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="center">
                    <Radio
                      size="small"
                      checked={side === 'mine'}
                      onChange={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'mine' }))}
                      inputProps={{ 'aria-label': `采用我方 ${diff.label}` }}
                    />
                  </TableCell>
                  <TableCell
                    onClick={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'theirs' }))}
                    sx={{
                      cursor: 'pointer',
                      bgcolor: side === 'theirs' ? 'rgba(38,166,154,.10)' : undefined,
                      border: side === 'theirs' ? '2px solid #26a69a' : '2px solid transparent',
                      maxWidth: 260,
                    }}
                  >
                    <Stack direction="row" spacing={0.5} alignItems="flex-start">
                      <Radio size="small" checked={side === 'theirs'} onChange={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'theirs' }))} />
                      <Typography variant="body2">{theirsText}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="center">
                    <Radio
                      size="small"
                      checked={side === 'theirs'}
                      onChange={() => setSideByField((prev) => ({ ...prev, [diff.field]: 'theirs' }))}
                      inputProps={{ 'aria-label': `采用对方 ${diff.label}` }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            {diffs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 2 }}>
                    两边记录的业务字段实际一致，可直接保存。
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          取消（不改，返回重排）
        </Button>
        <Button variant="contained" onClick={() => void confirm()} disabled={submitting}>
          {submitting ? '保存中…' : '按所选合并保存'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
