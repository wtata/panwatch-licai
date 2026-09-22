import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@panwatch/base-ui/components/ui/dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import InteractiveKline, { type KlineInterval } from '@panwatch/biz-ui/components/InteractiveKline'

export default function KlineModal(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol: string
  market: string
  title?: string
  description?: string
  initialInterval?: KlineInterval
  initialDays?: '60' | '120' | '250'
  onOpenSummary?: () => void
}) {
  const symbol = String(props.symbol || '').trim()
  const market = String(props.market || '').trim() || 'CN'

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 pr-6">
            <div>
              <DialogTitle>{props.title || (symbol ? `${symbol} 当日分时` : '当日分时')}</DialogTitle>
              <DialogDescription>
                {props.description || '当日实时分时（价格、均价、成交量），可切换日K / 周K / 月K。'}
              </DialogDescription>
            </div>
            {props.onOpenSummary ? (
              <Button variant="outline" size="sm" className="h-7 shrink-0 text-[12px]" onClick={props.onOpenSummary}>
                日K指标
              </Button>
            ) : null}
          </div>
        </DialogHeader>
        {symbol ? (
          <InteractiveKline
            symbol={symbol}
            market={market}
            initialInterval={props.initialInterval || 'trend'}
            initialDays={props.initialDays}
          />
        ) : (
          <div className="text-[12px] text-muted-foreground py-8 text-center">未选择股票</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
