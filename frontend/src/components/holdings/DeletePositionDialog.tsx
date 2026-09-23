import { useEffect, useState } from 'react'

import { Button } from '@panwatch/base-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'

interface DeletePositionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol: string
  name: string
  market: string
  quantity: number
  currentPrice: number | null
  onConfirm: (settleAtMarket: boolean) => Promise<void>
}

export default function DeletePositionDialog({
  open,
  onOpenChange,
  symbol,
  name,
  quantity,
  currentPrice,
  onConfirm,
}: DeletePositionDialogProps) {
  const [settle, setSettle] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSettle(false)
    setError('')
  }, [open, symbol])

  const confirm = async () => {
    setSubmitting(true)
    setError('')
    try {
      await onConfirm(settle)
    } catch (e) {
      setError(e instanceof Error ? e.message : '清空失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>清空持仓记录</DialogTitle>
          <DialogDescription>
            这是纠错入口，用来删掉错误的持仓行。默认不会当作卖出，也不会把钱加回可用资金。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          <div className="rounded-lg bg-accent/30 px-3 py-2 text-[13px]">
            <span className="font-mono text-muted-foreground mr-2">{symbol}</span>
            <span>{name}</span>
            <span className="ml-2 text-muted-foreground">剩余 {quantity} 股</span>
          </div>
          <p className="text-[12px] text-muted-foreground">只卖出一部分请关闭此窗口，改用「卖出」。</p>
          <label className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-1"
              checked={settle}
              aria-label="同时按现价回笼"
              onChange={e => setSettle(e.target.checked)}
            />
            <span>
              <span className="font-medium text-foreground">同时按现价回笼</span>
              <span className="block text-[12px] text-muted-foreground mt-0.5">
                勾选后按当前行情价卖出全部剩余股数，成交额计入该账户可用资金，并写入买卖流水。不勾选则只删除记录。
                {currentPrice != null
                  ? ` 当前现价 ${currentPrice}。`
                  : ' 当前没有现价，勾选后无法回笼，持仓也不会被删除。'}
              </span>
            </span>
          </label>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
            <Button variant="destructive" onClick={confirm} disabled={submitting}>
              {submitting ? '处理中…' : '确认清空'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
