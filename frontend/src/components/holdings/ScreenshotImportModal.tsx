import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clipboard, ImagePlus, Upload } from 'lucide-react'
import { fetchAPI, stocksApi } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { commitHoldingImport, enrichRowFromSearch, parseRowNumbers, type HoldingImportDeps } from '@/lib/ocr/importHoldings'
import { parseHoldings, toEditableRows, sanitizeEditableHoldings } from '@/lib/ocr/parseHoldings'
import { fileFromPasteEvent, readClipboardImage } from '@/lib/ocr/recognize'
import { scanHoldingsImage, type ScanHoldingsResult } from '@/lib/ocr/scanHoldings'
import type { EditableHoldingRow, PositionRef, StockRef } from '@/lib/ocr/types'

interface AccountOption {
  id: number
  name: string
}

interface ScreenshotImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: AccountOption[]
  defaultAccountId?: number | null
  existingStocks: StockRef[]
  existingPositions: PositionRef[]
  onImported: () => void
  recognizeImage?: (file: Blob, onProgress?: (info: { progress: number; status: string }) => void) => Promise<ScanHoldingsResult | { text: string; words?: ScanHoldingsResult['words'] }>
}

type Stage = 'idle' | 'ocr' | 'preview' | 'importing'

const importDeps: HoldingImportDeps = {
  searchStocks: (query, market) =>
    fetchAPI<Array<{ symbol: string; name: string; market: string }>>(
      `/stocks/search?q=${encodeURIComponent(query)}${market ? `&market=${encodeURIComponent(market)}` : ''}`,
    ),
  listStocks: () => stocksApi.list(),
  createStock: (payload) => stocksApi.create(payload),
  createPosition: (payload) => fetchAPI('/positions', { method: 'POST', body: JSON.stringify(payload) }),
  updatePosition: (id, payload) => fetchAPI(`/positions/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
}

function previewName(file: File): string {
  return URL.createObjectURL(file)
}

export default function ScreenshotImportModal({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
  existingStocks,
  existingPositions,
  onImported,
  recognizeImage = scanHoldingsImage,
}: ScreenshotImportModalProps) {
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewUrlRef = useRef<string | null>(null)
  const [accountId, setAccountId] = useState<string>('')
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [rows, setRows] = useState<EditableHoldingRow[]>([])
  const [error, setError] = useState('')

  const reset = useCallback(() => {
    setStage('idle')
    setProgress(0)
    setStatus('')
    setRows([])
    setError('')
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreviewUrl(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    const fallback = defaultAccountId ?? accounts[0]?.id
    setAccountId(fallback != null ? String(fallback) : '')
  }, [open, defaultAccountId, accounts, reset])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  const runOcr = useCallback(async (file: File) => {
    setError('')
    setRows([])
    setStage('ocr')
    setProgress(0)
    setStatus('正在读取截图')
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const url = previewName(file)
    previewUrlRef.current = url
    setPreviewUrl(url)
    try {
      const result = await recognizeImage(file, (info) => {
        setProgress(info.progress)
        setStatus(info.status)
      })
      const parsed = 'holdings' in result && Array.isArray(result.holdings) && result.holdings.length
        ? result.holdings
        : parseHoldings(result)
      const editable = toEditableRows(parsed)
      const enriched = await Promise.all(editable.map((row) => enrichRowFromSearch(row, importDeps.searchStocks)))
      setRows(sanitizeEditableHoldings(enriched))
      setStage('preview')
      if (enriched.length === 0) {
        setError('没有识别到股票，请换一张更清晰的同花顺持仓截图，或在预览中手工核对')
      }
    } catch (e) {
      setStage('idle')
      setError(e instanceof Error ? e.message : '识别失败')
    }
  }, [recognizeImage])

  useEffect(() => {
    if (!open) return
    const onPaste = (event: ClipboardEvent) => {
      const file = fileFromPasteEvent(event)
      if (!file) return
      event.preventDefault()
      void runOcr(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open, runOcr])

  const handleClipboard = async () => {
    const file = await readClipboardImage()
    if (!file) {
      toast('剪贴板里没有图片，请先截图后再粘贴', 'error')
      return
    }
    await runOcr(file)
  }

  const selectedValidCount = useMemo(
    () => rows.filter((row) => row.selected && !('error' in parseRowNumbers(row))).length,
    [rows],
  )

  const rematchTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const rematchSeq = useRef<Record<string, number>>({})

  const rematchRow = useCallback(async (id: string, next: EditableHoldingRow) => {
    const seq = (rematchSeq.current[id] || 0) + 1
    rematchSeq.current[id] = seq
    const enriched = await enrichRowFromSearch(next, importDeps.searchStocks)
    if (rematchSeq.current[id] !== seq) return
    setRows((prev) => prev.map((row) => {
      if (row.id !== id) return row
      const matched = Boolean(enriched.symbol)
      return {
        ...row,
        ...enriched,
        quantity: next.quantity,
        avgCost: next.avgCost,
        selected: matched ? true : row.selected,
      }
    }))
  }, [])

  const latestRow = (id: string) => {
    setRows((prev) => {
      const row = prev.find((item) => item.id === id)
      if (row) void rematchRow(id, row)
      return prev
    })
  }

  const updateRow = (id: string, patch: Partial<EditableHoldingRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    if (!('name' in patch) && !('symbol' in patch)) return
    window.clearTimeout(rematchTimers.current[id])
    rematchTimers.current[id] = setTimeout(() => latestRow(id), 350)
  }

  const rematchOnBlur = (id: string) => {
    window.clearTimeout(rematchTimers.current[id])
    latestRow(id)
  }

  const handleConfirm = async () => {
    if (!accountId) {
      toast('请先选择账户', 'error')
      return
    }
    const selected = rows.filter((row) => row.selected)
    if (selected.length === 0) {
      toast('请至少勾选一行', 'error')
      return
    }
    setStage('importing')
    try {
      const result = await commitHoldingImport({
        accountId: Number(accountId),
        rows,
        existingStocks,
        existingPositions: existingPositions.filter(
          (pos) => pos.account_id == null || pos.account_id === Number(accountId),
        ),
        deps: importDeps,
      })
      const accountName = accounts.find((item) => String(item.id) === accountId)?.name || '账户'
      if (result.failed.length === 0) {
        toast(`已导入 ${result.created + result.updated} 只到「${accountName}」（新增 ${result.created} / 更新 ${result.updated}）`, 'success')
        onOpenChange(false)
        onImported()
        return
      }
      if (result.created + result.updated > 0) {
        toast(
          `部分成功：新增 ${result.created}、更新 ${result.updated}、失败 ${result.failed.length}（${result.failed[0].symbol} ${result.failed[0].error}）`,
          'error',
        )
        onImported()
      } else {
        toast(`导入失败：${result.failed[0]?.error || '请核对后重试'}`, 'error')
      }
      setStage('preview')
    } catch (e) {
      setStage('preview')
      toast(e instanceof Error ? e.message : '导入失败', 'error')
    }
  }

  const dropEnabled = stage === 'idle' || stage === 'preview'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>截图导入持仓</DialogTitle>
          <DialogDescription>
            上传或粘贴券商/同花顺持仓截图。优先按表格列读取「持仓数量」和「成本价」，不用现价或可卖数量。识别后仍可改，再写入选定账户。
          </DialogDescription>
        </DialogHeader>

        {accounts.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">请先添加账户，再导入持仓。</p>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>导入到账户</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="选择账户" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div
              className="rounded-xl border border-dashed border-border/80 bg-accent/20 p-4 text-center"
              onDragOver={(event) => {
                if (!dropEnabled) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                if (!dropEnabled) return
                event.preventDefault()
                const file = event.dataTransfer.files?.[0]
                if (file && file.type.startsWith('image/')) void runOcr(file)
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void runOcr(file)
                }}
              />
              <ImagePlus className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
              <p className="text-[13px] text-foreground">拖拽截图到这里，或点击上传 / Ctrl+V 粘贴</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={stage === 'ocr' || stage === 'importing'} onClick={() => fileInputRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" /> 选择图片
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={stage === 'ocr' || stage === 'importing'} onClick={() => void handleClipboard()}>
                  <Clipboard className="h-3.5 w-3.5" /> 从剪贴板粘贴
                </Button>
              </div>
            </div>

            {previewUrl && (
              <img src={previewUrl} alt="持仓截图预览" className="max-h-40 w-full rounded-lg border border-border/50 object-contain bg-background" />
            )}

            {stage === 'ocr' && (
              <div>
                <div className="h-1.5 overflow-hidden rounded-full bg-accent">
                  <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} />
                </div>
                <p className="mt-2 text-[12px] text-muted-foreground">{status || '识别中...'}</p>
              </div>
            )}

            {error && <p className="text-[12px] text-destructive">{error}</p>}

            {rows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-border/50">
                <table className="w-full min-w-[640px] text-[12px]">
                  <thead>
                    <tr className="border-b border-border/40 bg-accent/30 text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">
                        <input
                          type="checkbox"
                          aria-label="全选"
                          checked={rows.every((row) => row.selected)}
                          onChange={(event) => setRows((prev) => prev.map((row) => ({ ...row, selected: event.target.checked })))}
                        />
                      </th>
                      <th className="px-2 py-2 text-left font-medium">代码</th>
                      <th className="px-2 py-2 text-left font-medium">名称</th>
                      <th className="px-2 py-2 text-left font-medium">数量</th>
                      <th className="px-2 py-2 text-left font-medium">成本</th>
                      <th className="px-2 py-2 text-left font-medium">提示</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const invalid = row.selected && 'error' in parseRowNumbers(row)
                      return (
                        <tr key={row.id} className={`border-t border-border/20 ${invalid ? 'bg-destructive/5' : ''}`}>
                          <td className="px-2 py-1.5">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${row.symbol}`}
                              checked={row.selected}
                              onChange={(event) => updateRow(row.id, { selected: event.target.checked })}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              className="h-8 px-2 font-mono"
                              value={row.symbol}
                              onChange={(event) => updateRow(row.id, { symbol: event.target.value })}
                              onBlur={() => rematchOnBlur(row.id)}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input
                              className="h-8 px-2"
                              value={row.name}
                              onChange={(event) => updateRow(row.id, { name: event.target.value })}
                              onBlur={() => rematchOnBlur(row.id)}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 px-2 font-mono" value={row.quantity} onChange={(event) => updateRow(row.id, { quantity: event.target.value })} />
                          </td>
                          <td className="px-2 py-1.5">
                            <Input className="h-8 px-2 font-mono" value={row.avgCost} onChange={(event) => updateRow(row.id, { avgCost: event.target.value })} />
                          </td>
                          <td className="px-2 py-1.5 text-[11px] text-amber-600">
                            {row.warnings.join('；') || (invalid ? '请补全数量和成本' : '')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
              <Button
                type="button"
                disabled={stage === 'ocr' || stage === 'importing' || selectedValidCount === 0 || !accountId}
                onClick={() => void handleConfirm()}
              >
                {stage === 'importing' ? '写入中...' : `确认导入（${selectedValidCount}）`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
