import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import ConflictBadge from '../components/common/ConflictBadge';
import FieldRow from '../components/common/FieldRow';
import RevisionConflictDialog from '../components/common/RevisionConflictDialog';
import { usePersistentStore, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { useSessionStore, type SaveSessionResult } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { FILTER_NAMES, SESSION_STATUSES, type ObsSession, type SessionStatus, type StaleTelescopeBlock } from '../types';
import { revisionOf } from '../utils/revision';
import { SESSION_FIELD_LABELS, sessionFieldFormatter } from '../utils/fieldLabels';
import { axisMinutes, durationMinutes, formatMinutes } from '../utils/astro';

interface SessionFormState {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason: string;
}

/** 待裁决的并发冲突（单条编辑与批量改期共用一个队列，逐条弹出裁决） */
interface ConflictEntry {
  current: ObsSession;
  attempted: ObsSession;
  expectedRevision: number;
  /** 裁决时的望远镜旧状态（本页签看到的），用于设备状态退回校验 */
  seenTelescopeStatus?: string;
}

/** 排程段列表与冲突检测结果，支持批量改期到备用观测夜 */
export default function SessionsPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const createSession = useSessionStore((s) => s.createSession);
  const saveSession = useSessionStore((s) => s.saveSession);
  const resolveSession = useSessionStore((s) => s.resolveSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const rescheduleToBackup = useSessionStore((s) => s.rescheduleToBackup);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const { findConflicts, conflictIds } = useConflictCheck();

  /** 支持从设备分配视图一键跳转：?night=<夜ID>&highlight=<排程段ID> */
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight') ?? '';
  const nightParam = searchParams.get('night') ?? '';
  const [nightFilter, setNightFilter] = useState(nightParam || '全部');
  const [statusFilter, setStatusFilter] = useState('全部');
  const [onlyConflict, setOnlyConflict] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  /** 打开编辑对话框时该记录的改动序号（乐观锁基线） */
  const [baseRevision, setBaseRevision] = useState<number | undefined>(undefined);
  /** 打开编辑对话框时所选望远镜的状态（设备侧若在期间改为维护中/外出则退回） */
  const [seenTelescopeStatus, setSeenTelescopeStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [block, setBlock] = useState<StaleTelescopeBlock | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleNight, setRescheduleNight] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  /** 并发冲突裁决队列（批量改期可能攒下多条，逐条弹） */
  const [conflictQueue, setConflictQueue] = useState<ConflictEntry[]>([]);
  const [form, setForm] = useState<SessionFormState>({
    nightId: '',
    targetId: '',
    startTime: '20:00',
    endTime: '21:00',
    telescopeId: '',
    instrumentId: '',
    filterSlot: 'L',
    plannedFrames: 30,
    status: '待执行',
    rescheduleReason: '',
  });

  const activeConflict = conflictQueue[0] ?? null;

  const conflictSet = useMemo(() => conflictIds(), [conflictIds]);
  const backupNights = useMemo(() => nights.filter((night) => night.backup), [nights]);

  const visible = useMemo(() => {
    return [...sessions]
      .filter((session) => {
        if (nightFilter !== '全部' && session.nightId !== nightFilter) return false;
        if (statusFilter !== '全部' && session.status !== statusFilter) return false;
        if (onlyConflict && !conflictSet.has(session.id)) return false;
        return true;
      })
      .sort((a, b) => a.nightId.localeCompare(b.nightId) || axisMinutes(a.startTime) - axisMinutes(b.startTime));
  }, [sessions, nightFilter, statusFilter, onlyConflict, conflictSet]);

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const telescopeById = (id: string) => telescopes.find((item) => item.id === id);
  const instrumentById = (id: string) => instruments.find((item) => item.id === id);
  const nightById = (id: string) => nights.find((night) => night.id === id);

  const formatField = useMemo(
    () => sessionFieldFormatter({ nights, targets, telescopes, instruments }),
    [nights, targets, telescopes, instruments],
  );

  const liveConflicts = useMemo(() => {
    if (!dialogOpen) return [];
    return findConflicts({
      nightId: form.nightId,
      telescopeId: form.telescopeId,
      startTime: form.startTime,
      endTime: form.endTime,
      ignoreSessionId: editingId || undefined,
    });
  }, [dialogOpen, findConflicts, form.nightId, form.telescopeId, form.startTime, form.endTime, editingId]);

  /** 当前选中望远镜的实时状态（表单切换望远镜时同步旧状态基线） */
  const selectedTelescopeStatus = telescopeById(form.telescopeId)?.status;

  function openCreate() {
    setEditingId('');
    setBaseRevision(undefined);
    setBlock(null);
    setError('');
    const night = nights.find((item) => item.primary) ?? nights[0];
    const telescope = telescopes.find((item) => item.status === '可用') ?? telescopes[0];
    const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
    setForm({
      nightId: night?.id ?? '',
      targetId: targets[0]?.id ?? '',
      startTime: '20:00',
      endTime: '21:00',
      telescopeId: telescope?.id ?? '',
      instrumentId: instrument?.id ?? '',
      filterSlot: 'L',
      plannedFrames: 30,
      status: '待执行',
      rescheduleReason: '',
    });
    setSeenTelescopeStatus(telescope?.status);
    setDialogOpen(true);
  }

  function openEdit(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    setEditingId(id);
    setBaseRevision(revisionOf(session));
    setBlock(null);
    setError('');
    setForm({
      nightId: session.nightId,
      targetId: session.targetId,
      startTime: session.startTime,
      endTime: session.endTime,
      telescopeId: session.telescopeId,
      instrumentId: session.instrumentId,
      filterSlot: session.filterSlot,
      plannedFrames: session.plannedFrames,
      status: session.status,
      rescheduleReason: session.rescheduleReason ?? '',
    });
    setSeenTelescopeStatus(telescopeById(session.telescopeId)?.status);
    setDialogOpen(true);
  }

  function buildAttemptedSession(): ObsSession {
    const existing = editingId ? sessions.find((session) => session.id === editingId) : undefined;
    if (existing) {
      return normalizeAttempted(existing);
    }
    return createSession({ ...form, rescheduleReason: form.rescheduleReason.trim() || undefined });

    function normalizeAttempted(existing: ObsSession): ObsSession {
      return {
        ...existing,
        nightId: form.nightId,
        targetId: form.targetId,
        startTime: form.startTime,
        endTime: form.endTime,
        telescopeId: form.telescopeId,
        instrumentId: form.instrumentId,
        filterSlot: form.filterSlot,
        plannedFrames: Number(form.plannedFrames) || 0,
        status: form.status,
        rescheduleReason: form.rescheduleReason.trim() || undefined,
        schemaVersion: SCHEMA_VERSION,
        revision: baseRevision ?? revisionOf(existing),
      };
    }
  }

  /** 保存返回「望远镜已不可用」退回时，写清是哪台设备发生了什么变化 */
  function describeBlock(next: StaleTelescopeBlock): string {
    return `排程被退回：望远镜 ${next.telescopeCode}（${next.telescopeId}）已被设备侧改为「${next.currentStatus}」（你打开本段时它还是「${next.seenStatus}」），该状态不可排程，请改换可用望远镜或改期后重排。`;
  }

  function enqueueConflict(outcome: Extract<SaveSessionResult, { type: 'conflict' }>['outcome'], attempted: ObsSession, seen?: string) {
    if (outcome.type !== 'conflict') return;
    const entry: ConflictEntry = {
      current: outcome.current,
      attempted,
      expectedRevision: revisionOf(outcome.current),
      seenTelescopeStatus: seen,
    };
    setConflictQueue((queue) => [...queue, entry]);
  }

  async function submit() {
    if (!form.nightId || !form.targetId || !form.telescopeId) {
      setError('观测夜、目标与望远镜均为必填');
      return;
    }
    if (durationMinutes(form.startTime, form.endTime) <= 0) {
      setError('结束时刻必须晚于开始时刻');
      return;
    }
    if (liveConflicts.length > 0) {
      setError('该望远镜在所选时段已有排程，请调整时段或改期到备用观测夜');
      return;
    }
    setSaving(true);
    setError('');
    setBlock(null);
    try {
      const attempted = buildAttemptedSession();
      if (editingId) {
        const result = await saveSession(attempted, baseRevision, seenTelescopeStatus);
        if (result.type === 'saved') {
          setNotice(result.unchanged ? '记录内容未变化，已保留最新版本' : '已更新排程段');
          setDialogOpen(false);
        } else if (result.type === 'telescope-blocked') {
          setBlock(result.block);
          setError(describeBlock(result.block));
        } else {
          // 同一记录两边都动过：不覆盖，摊开差异让人定夺（编辑对话框保留在下层，不丢草稿）
          enqueueConflict(result.outcome, attempted, seenTelescopeStatus);
        }
      } else {
        const attempted = buildAttemptedSession();
        const checked = await saveSession(attempted, undefined, seenTelescopeStatus);
        if (checked.type === 'saved') {
          setNotice('已新增排程段');
          setDialogOpen(false);
        } else if (checked.type === 'telescope-blocked') {
          setBlock(checked.block);
          setError(describeBlock(checked.block));
        } else {
          enqueueConflict(checked.outcome, checked.outcome.attempted, seenTelescopeStatus);
        }
      }
    } finally {
      setSaving(false);
    }
  }

  /** 冲突对话框确认：按所选字段合并；落库期间又被改动则以新 current 继续留在队列里 */
  async function resolveActiveConflict(sideByField: Record<string, 'mine' | 'theirs'>): Promise<boolean> {
    if (!activeConflict) return true;
    const result = await resolveSession(
      activeConflict.current,
      activeConflict.attempted,
      sideByField,
      activeConflict.seenTelescopeStatus,
    );
    if (result.type === 'telescope-blocked') {
      setBlock(result.block);
      setError(describeBlock(result.block));
      setConflictQueue((queue) => queue.slice(1));
      return true;
    }
    if (result.type === 'conflict') {
      setConflictQueue((queue) => [{ ...activeConflict, current: result.outcome.current as ObsSession }, ...queue.slice(1)]);
      return false;
    }
    setConflictQueue((queue) => queue.slice(1));
    setNotice('已按裁决合并保存，两边改动均已保留');
    return true;
  }

  async function submitReschedule() {
    if (!rescheduleNight) {
      setError('请选择备用观测夜');
      return;
    }
    setSaving(true);
    setError('');
    setBlock(null);
    try {
      // 以当前列表里各望远镜的状态作为本页签基线
      const telescopeStatusById = new Map(telescopes.map((telescope) => [telescope.id, telescope.status]));
      const results = await rescheduleToBackup(selected, rescheduleNight, rescheduleReason, telescopeStatusById);
      const blocked = results.filter((result): result is Extract<SaveSessionResult, { type: 'telescope-blocked' }> => result.type === 'telescope-blocked');
      const conflicts = results.filter((result): result is Extract<SaveSessionResult, { type: 'conflict' }> => result.type === 'conflict');
      const savedCount = results.filter((result) => result.type === 'saved').length;

      if (blocked.length > 0) setBlock(blocked[0].block);

      conflicts.forEach((result) => {
        const attempted = {
          ...(result.outcome.attempted as ObsSession),
        };
        enqueueConflict(
          result.outcome,
          attempted,
          telescopeStatusById.get(attempted.telescopeId),
        );
      });

      if (conflicts.length === 0 && blocked.length === 0) {
        setNotice(`已将 ${savedCount} 个排程段改期至 ${nightById(rescheduleNight)?.date ?? rescheduleNight}，原因：${rescheduleReason || '未填写'}`);
        setSelected([]);
      } else {
        const blockedText = blocked.length > 0 ? describeBlock(blocked[0].block) : '';
        setNotice(
          `改期结果：${savedCount} 段已保存，${conflicts.length} 段与另一页签的改动冲突待裁决，${blocked.length} 段因望远镜不可用被退回。${
            blocked.length > 1 ? `（其余 ${blocked.length - 1} 条退回明细与本条同理）` : ''
          }${blockedText ? `\n${blockedText}` : ''}`,
        );
        // 冲突段保留勾选，裁决完成后可直接对退回段重试
        if (conflicts.length === 0) setSelected([]);
      }
      setRescheduleOpen(false);
      setRescheduleReason('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        排程段列表与冲突检测
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        同一时段同一望远镜重复排入即进入冲突列表；支持勾选多个排程段批量改期到备用观测夜并填写改期原因。与设备分配视图同时保存时，没碰上的记录照常存下，同一条两边都动过会逐字段摊开裁决。
      </Typography>

      {notice ? (
        <Alert severity={block ? 'warning' : 'success'} sx={{ mb: 2, whiteSpace: 'pre-line' }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      {block ? (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setBlock(null)}>
          {describeBlock(block)}
        </Alert>
      ) : null}

      {highlightId ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          已从设备分配视图定位到排程段 <strong>{highlightId}</strong>（对应行已用左侧红条标出）
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center">
        <Button variant="contained" onClick={openCreate}>
          新增排程段
        </Button>
        <Button variant="outlined" color="warning" disabled={selected.length === 0} onClick={() => setRescheduleOpen(true)}>
          批量改期到备用夜（已选 {selected.length}）
        </Button>
        <TextField select size="small" label="观测夜" value={nightFilter} onChange={(event) => setNightFilter(event.target.value)} sx={{ minWidth: 200 }}>
          {['全部', ...nights.map((night) => night.id)].map((id) => (
            <MenuItem key={id} value={id}>
              {id === '全部' ? '全部' : `${nightById(id)?.date ?? id}${nightById(id)?.primary ? '（主夜）' : '（备用夜）'}`}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 140 }}>
          {['全部', ...SESSION_STATUSES].map((status) => (
            <MenuItem key={status} value={status}>
              {status}
            </MenuItem>
          ))}
        </TextField>
        <Button variant={onlyConflict ? 'contained' : 'outlined'} color="error" onClick={() => setOnlyConflict((value) => !value)}>
          仅看冲突（{conflictSet.size} 段）
        </Button>
        <Chip size="small" label={`命中 ${visible.length} / ${sessions.length}`} />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={visible.length > 0 && selected.length === visible.length}
                  onChange={(event) => setSelected(event.target.checked ? visible.map((session) => session.id) : [])}
                />
              </TableCell>
              <TableCell>观测夜</TableCell>
              <TableCell>时段</TableCell>
              <TableCell>目标</TableCell>
              <TableCell>望远镜 / 终端</TableCell>
              <TableCell>滤镜</TableCell>
              <TableCell align="right">帧数</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>冲突</TableCell>
              <TableCell>改期原因</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((session) => {
              const conflicts = findConflicts({
                nightId: session.nightId,
                telescopeId: session.telescopeId,
                startTime: session.startTime,
                endTime: session.endTime,
                ignoreSessionId: session.id,
              });
              const telescope = telescopeById(session.telescopeId);
              const telescopeUnavailable = telescope ? telescope.status === '维护中' || telescope.status === '外出' : false;
              return (
                <TableRow
                  key={session.id}
                  hover
                  selected={selected.includes(session.id)}
                  sx={session.id === highlightId ? { boxShadow: 'inset 4px 0 0 #d32f2f' } : telescopeUnavailable ? { bgcolor: 'rgba(245,124,0,.08)' } : undefined}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={selected.includes(session.id)}
                      onChange={(event) =>
                        setSelected((prev) => (event.target.checked ? [...prev, session.id] : prev.filter((id) => id !== session.id)))
                      }
                    />
                  </TableCell>
                  <TableCell>{nightById(session.nightId)?.date ?? session.nightId}</TableCell>
                  <TableCell>
                    {session.startTime}-{session.endTime}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {formatMinutes(durationMinutes(session.startTime, session.endTime))}
                    </Typography>
                  </TableCell>
                  <TableCell>{targetById(session.targetId)?.name ?? '未知目标'}</TableCell>
                  <TableCell>
                    {telescope?.code ?? '-'} / {instrumentById(session.instrumentId)?.model ?? '-'}
                    {telescopeUnavailable ? (
                      <Chip size="small" color="warning" variant="outlined" label={`望远镜${telescope?.status}，需重排`} sx={{ ml: 0.5 }} />
                    ) : null}
                  </TableCell>
                  <TableCell>{session.filterSlot}</TableCell>
                  <TableCell align="right">{session.plannedFrames}</TableCell>
                  <TableCell>
                    <StatusChip status={session.status} />
                  </TableCell>
                  <TableCell>
                    <ConflictBadge conflicts={conflicts} compact />
                  </TableCell>
                  <TableCell>
                    {session.rescheduleReason ? (
                      <Typography variant="caption">{session.rescheduleReason}</Typography>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        -
                      </Typography>
                    )}
                    {session.backupNightId ? (
                      <Chip size="small" variant="outlined" label={`替补 ${nightById(session.backupNightId)?.date ?? session.backupNightId}`} sx={{ ml: 0.5 }} />
                    ) : null}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => openEdit(session.id)}>
                      编辑
                    </Button>
                    <Button size="small" color="error" onClick={() => void removeSession(session.id)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => (saving ? undefined : setDialogOpen(false))} maxWidth="sm" fullWidth>
        <DialogTitle>{editingId ? '编辑排程段' : '新增排程段'}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {error}
            </Alert>
          ) : null}
          {selectedTelescopeStatus === '维护中' || selectedTelescopeStatus === '外出' ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              所选望远镜当前为「{selectedTelescopeStatus}」，保存会被退回，请改换可用望远镜或改期。
            </Alert>
          ) : null}
          {liveConflicts.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              该望远镜在所选时段已有 {liveConflicts.length} 段排程：
              {liveConflicts.map((conflict) => ` ${conflict.otherId}（${conflict.overlapText}）`).join('；')}
            </Alert>
          ) : (
            <Alert severity="success" sx={{ mb: 1.5 }}>
              时段校验通过，该望远镜此时段空闲
            </Alert>
          )}
          <FieldRow label="观测夜" required>
            <TextField select size="small" fullWidth value={form.nightId} onChange={(event) => setForm({ ...form, nightId: event.target.value })}>
              {nights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.siteName}${night.primary ? '（主夜）' : night.backup ? '（备用夜）' : ''}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="观测目标" required>
            <TextField select size="small" fullWidth value={form.targetId} onChange={(event) => setForm({ ...form, targetId: event.target.value })}>
              {targets.map((target) => (
                <MenuItem key={target.id} value={target.id}>
                  {`${target.name}（${target.catalog}）· ${target.magnitude} 等`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="开始时刻" required hint="格式 HH:mm，可跨零点">
            <TextField size="small" fullWidth value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} placeholder="20:00" />
          </FieldRow>
          <FieldRow label="结束时刻" required>
            <TextField size="small" fullWidth value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} placeholder="21:30" />
          </FieldRow>
          <FieldRow label="望远镜" required>
            <TextField
              select
              size="small"
              fullWidth
              value={form.telescopeId}
              onChange={(event) => {
                const telescope = telescopes.find((item) => item.id === event.target.value);
                const instrument = instruments.find((item) => item.telescopeCode === telescope?.code);
                setForm({ ...form, telescopeId: event.target.value, instrumentId: instrument?.id ?? '' });
                setSeenTelescopeStatus(telescope?.status);
              }}
            >
              {telescopes.map((telescope) => (
                <MenuItem key={telescope.id} value={telescope.id}>
                  {`${telescope.code} · ${telescope.apertureMm}mm f/${(telescope.focalLengthMm / telescope.apertureMm).toFixed(1)} · ${telescope.status}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="终端">
            <TextField select size="small" fullWidth value={form.instrumentId} onChange={(event) => setForm({ ...form, instrumentId: event.target.value })}>
              {instruments
                .filter((instrument) => instrument.telescopeCode === telescopeById(form.telescopeId)?.code)
                .map((instrument) => (
                  <MenuItem key={instrument.id} value={instrument.id}>
                    {`${instrument.model} · ${instrument.terminalType}`}
                  </MenuItem>
                ))}
            </TextField>
          </FieldRow>
          <FieldRow label="滤镜轮位">
            <TextField select size="small" fullWidth value={form.filterSlot} onChange={(event) => setForm({ ...form, filterSlot: event.target.value })}>
              {FILTER_NAMES.map((filter) => (
                <MenuItem key={filter} value={filter}>
                  {filter}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="计划帧数" required>
            <TextField size="small" type="number" fullWidth value={form.plannedFrames} onChange={(event) => setForm({ ...form, plannedFrames: Number(event.target.value) })} />
          </FieldRow>
          <FieldRow label="状态">
            <TextField select size="small" fullWidth value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SessionStatus })}>
              {SESSION_STATUSES.map((status) => (
                <MenuItem key={status} value={status}>
                  {status}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因">
            <TextField size="small" fullWidth multiline minRows={2} value={form.rescheduleReason} onChange={(event) => setForm({ ...form, rescheduleReason: event.target.value })} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="contained" onClick={() => void submit()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={rescheduleOpen} onClose={() => (saving ? undefined : setRescheduleOpen(false))} maxWidth="sm" fullWidth>
        <DialogTitle>批量改期到备用观测夜</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            已选 {selected.length} 个排程段，改期后状态将置为「因云取消」并记录替补夜与改期原因。
          </Alert>
          <FieldRow label="备用观测夜" required>
            <TextField select size="small" fullWidth value={rescheduleNight} onChange={(event) => setRescheduleNight(event.target.value)}>
              {backupNights.map((night) => (
                <MenuItem key={night.id} value={night.id}>
                  {`${night.date} · ${night.cloudText} · 月相 ${night.moonPhasePct}% · ${night.dutyOfficer}`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
          <FieldRow label="改期原因" required hint="例如：夜间云量转多云，目标被云遮挡">
            <TextField size="small" fullWidth multiline minRows={2} value={rescheduleReason} onChange={(event) => setRescheduleReason(event.target.value)} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRescheduleOpen(false)} disabled={saving}>
            取消
          </Button>
          <Button variant="contained" color="warning" onClick={() => void submitReschedule()} disabled={saving}>
            {saving ? '处理中…' : '确认改期'}
          </Button>
        </DialogActions>
      </Dialog>

      <RevisionConflictDialog<ObsSession>
        open={activeConflict !== null}
        current={activeConflict?.current ?? null}
        attempted={activeConflict?.attempted ?? null}
        labels={SESSION_FIELD_LABELS}
        formatValue={formatField}
        description={`排程段 ${activeConflict?.current.id ?? ''} 同时被设备分配视图与排程段列表改动。未改动的字段自动保留，请为下列字段选择最终内容。`}
        onResolve={resolveActiveConflict}
        onClose={() => setConflictQueue((queue) => queue.slice(1))}
      />
    </Box>
  );
}
