import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'

export interface PortfolioTradeRow {
  id: number
  traded_at: string | null
  account_name: string
  stock_symbol: string
  stock_name: string
  stock_market: string
  side: 'buy' | 'sell' | string
  quantity: number
  price: number
  fee: number
  amount: number
  cash_delta: number
  fx_rate: number
  position_quantity_before: number
  position_quantity_after: number
  cost_price_before: number | null
  cost_price_after: number | null
  available_funds_before: number
  available_funds_after: number
  note: string
}

interface TradeHistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accountName?: string
  trades: PortfolioTradeRow[]
  loading: boolean
  error: string
}

function money(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function plain(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function TradeHistoryDialog({
  open,
  onOpenChange,
  accountName,
  trades,
  loading,
  error,
}: TradeHistoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>买卖流水</DialogTitle>
          <DialogDescription>
            {accountName ? `仅显示「${accountName}」` : '全部实盘账户'}。这里是真实持仓的成交记录，不含模拟盘。
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 max-h-[60vh] overflow-auto space-y-2">
          {loading && <p className="text-[13px] text-muted-foreground py-6 text-center">加载中…</p>}
          {!loading && error && <p className="text-[13px] text-destructive py-6 text-center">{error}</p>}
          {!loading && !error && trades.length === 0 && (
            <p className="text-[13px] text-muted-foreground py-8 text-center">
              还没有买卖流水。在持仓里点「买入」或「卖出」后会出现在这里。
            </p>
          )}
          {!loading && !error && trades.map(trade => {
            const buy = trade.side === 'buy'
            return (
              <div key={trade.id} className="rounded-xl border border-border/50 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className={buy ? 'text-rose-600 font-medium' : 'text-emerald-600 font-medium'}>
                    {buy ? '买入' : '卖出'}
                  </span>
                  <span className="font-mono">{trade.stock_symbol}</span>
                  <span className="truncate">{trade.stock_name}</span>
                  <span className="ml-auto font-mono">{trade.quantity} 股 @ {trade.price}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                  <span>{trade.account_name}</span>
                  <span>成交额 {plain(trade.amount)}</span>
                  <span>手续费 {plain(trade.fee)}</span>
                  <span>现金 {money(trade.cash_delta)} 元</span>
                  {trade.fx_rate !== 1 && <span>汇率 {trade.fx_rate}</span>}
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  仓位 {trade.position_quantity_before} → {trade.position_quantity_after} 股
                  <span className="mx-2">·</span>
                  可用 {plain(trade.available_funds_before)} → {plain(trade.available_funds_after)} 元
                  {trade.cost_price_after != null && (
                    <>
                      <span className="mx-2">·</span>
                      成本 {trade.cost_price_after}
                    </>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground/80">
                  {trade.traded_at || '—'}
                  {trade.note ? ` · ${trade.note}` : ''}
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
