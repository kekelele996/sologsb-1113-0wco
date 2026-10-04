import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { formatFieldValue, type RecordConflict } from '../../utils/merge';

export interface ConflictDialogProps {
  open: boolean;
  conflict: RecordConflict | null;
  onClose: () => void;
  /** 裁决回调：row 为合并后的完整记录；null 表示接受对方删除 */
  onResolve: (row: Record<string, unknown> | null) => void;
}

type Choice = 'ours' | 'theirs';

/**
 * 并发修改冲突对话框：同一条记录被两个页签都改过时，摊开每个字段的差异，
 * 让人定用哪边；没冲突的字段已自动合并。
 */
export default function ConflictDialog({ open, conflict, onClose, onResolve }: ConflictDialogProps) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    if (conflict) {
      const initial: Record<string, Choice> = {};
      conflict.fields.forEach((field) => {
        initial[field.field] = 'ours';
      });
      setChoices(initial);
    }
  }, [conflict]);

  if (!conflict) return null;

  const theirsMissing = Boolean(conflict.theirsMissing);

  function chooseAll(choice: Choice) {
    if (!conflict) return;
    const next: Record<string, Choice> = {};
    conflict.fields.forEach((field) => {
      next[field.field] = choice;
    });
    setChoices(next);
  }

  function handleResolve() {
    if (!conflict) return;
    if (theirsMissing) {
      onResolve({ ...conflict.ours });
      return;
    }
    const row: Record<string, unknown> = { ...conflict.theirs };
    conflict.fields.forEach((field) => {
      row[field.field] = choices[field.field] === 'ours' ? field.ours : field.theirs;
    });
    onResolve(row);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>该{conflict.recordLabel}在另一个页签被修改过</DialogTitle>
      <DialogContent>
        {theirsMissing ? (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            该{conflict.recordLabel}已被另一个页签删除。选择「保留我方版本」将写回我方内容；选择「接受删除」将不再保留。
          </Alert>
        ) : (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            两个页签都改动了同一条{conflict.recordLabel}。以下字段两边不一致，请选择采用哪边的值；未列出的字段已自动合并。
          </Alert>
        )}

        {theirsMissing ? null : (
          <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
            <Button size="small" variant="outlined" onClick={() => chooseAll('ours')}>
              全部用我方
            </Button>
            <Button size="small" variant="outlined" onClick={() => chooseAll('theirs')}>
              全部用对方
            </Button>
          </Stack>
        )}

        {theirsMissing
          ? null
          : conflict.fields.map((field) => (
              <Box key={field.field} sx={{ mb: 1.5, p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                  {field.label}
                </Typography>
                <RadioGroup
                  value={choices[field.field] ?? 'ours'}
                  onChange={(event) => setChoices((prev) => ({ ...prev, [field.field]: event.target.value as Choice }))}
                >
                  <FormControlLabel
                    value="ours"
                    control={<Radio size="small" />}
                    label={
                      <Typography variant="body2">
                        我方：{formatFieldValue(field.field, field.ours)}
                      </Typography>
                    }
                  />
                  <FormControlLabel
                    value="theirs"
                    control={<Radio size="small" />}
                    label={
                      <Typography variant="body2">
                        对方：{formatFieldValue(field.field, field.theirs)}
                      </Typography>
                    }
                  />
                </RadioGroup>
              </Box>
            ))}

        {theirsMissing ? null : (
          <>
            <Divider sx={{ my: 1 }} />
            <Typography variant="caption" color="text.secondary">
              我方 = 本页签当前表单内容；对方 = 另一个页签已保存的内容。
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        {theirsMissing ? (
          <>
            <Button color="error" onClick={() => onResolve(null)}>
              接受删除
            </Button>
            <Button variant="contained" onClick={handleResolve}>
              保留我方版本
            </Button>
          </>
        ) : (
          <Button variant="contained" onClick={handleResolve}>
            按所选合并
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
