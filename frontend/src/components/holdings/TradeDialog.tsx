import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'

import { Button } from '@panwatch/base-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'

import { previewTrade, type ExchangeRates } from './tradePreview'

export interface TradeStock {
  stockId: number
  symbol: string
  name: string
  market: string
  positionId: number | null
  quantity: number
  costPrice: number
  investedAmount: number | null
  currentPrice: number | null
}

export interface TradeAccount {
  id: number
  name: string
  availableFunds: number
  positions: TradeStock[]
}

export interface TradeDraft {
  side: 'buy' | 'sell'
  accountId: number
  positionId: number | null
  stockId: number
  symbol: string
  name: string
  market: string
  quantity: number
  price: number
  fee: number
}

export interface StockSearchHit {
  symbol: string
  name: string
  market: string
}

interface TradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side: 'buy' | 'sell'
  account: TradeAccount | null
  stock: TradeStock | null
  exchangeRates?: ExchangeRates
  onSearch: (query: string, market: string) => Promise<StockSearchHit[]>
  onSubmit: (draft: TradeDraft) => Promise<void>
}

function money(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function costText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(4).replace(/\.?0+$/, '')
}

function priceCurrency(market: string): string {
  if (market === 'HK') return '港币'
  if (market === 'US') return '美元'
  return '元'
}

function parseFee(raw: string): number {
  if (!raw.trim()) return 0
  return Number(raw)
}

export default function TradeDialog({
  open,
  onOpenChange,
  side,
  account,
  stock,
  exchangeRates,
  onSearch,
  onSubmit,
}: TradeDialogProps) {
  const [picked, setPicked] = useState<TradeStock | null>(stock)
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fee, setFee] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [query, setQuery] = useState('')
  const [searchMarket, setSearchMarket] = useState('')
  const [hits, setHits] = useState<StockSearchHit[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
    setPicked(stock)
    setQuantity('')
    setPrice(stock?.currentPrice ? String(stock.currentPrice) : '')
    setFee('')
    setError('')
    setQuery('')
    setHits([])
    setSearchMarket(stock?.market || '')
  }, [open, side, stock, account?.id])

  useEffect(() => {
    if (!open || stock || !query.trim()) {
      setHits([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        const rows = await onSearch(query.trim(), searchMarket)
        if (!cancelled) setHits(rows)
      } catch {
        if (!cancelled) setHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, stock, query, searchMarket, onSearch])

  const active = picked
  const parsedQuantity = Number(quantity)
  const parsedPrice = Number(price)
  const parsedFee = parseFee(fee)
  const preview = useMemo(() => {
    if (!active || !quantity.trim() || !price.trim()) return null
    return previewTrade({
      side,
      quantity: parsedQuantity,
      price: parsedPrice,
      fee: parsedFee,
      market: active.market,
      heldQuantity: active.quantity,
      costPrice: active.costPrice,
      investedAmount: active.investedAmount,
      availableFunds: account?.availableFunds ?? 0,
      rates: exchangeRates,
    })
  }, [active, side, quantity, price, parsedQuantity, parsedPrice, parsedFee, account?.availableFunds, exchangeRates])

  const chooseHit = (hit: StockSearchHit) => {
    const held = account?.positions.find(item => item.symbol === hit.symbol && item.market === hit.market)
    setPicked(held || {
      stockId: 0,
      symbol: hit.symbol,
      name: hit.name,
      market: hit.market,
      positionId: null,
      quantity: 0,
      costPrice: 0,
      investedAmount: null,
      currentPrice: null,
    })
    setQuery(`${hit.symbol} ${hit.name}`)
    setHits([])
  }

  const submit = async () => {
    if (!account || !active || !preview?.valid) {
      setError(preview?.error || '请填写数量和成交价')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({
        side,
        accountId: account.id,
        positionId: active.positionId,
        stockId: active.stockId,
        symbol: active.symbol,
        name: active.name,
        market: active.market,
        quantity: parsedQuantity,
        price: parsedPrice,
        fee: parsedFee,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const title = side === 'buy' ? '买入' : '卖出'
  const market = active?.market || 'CN'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {account ? `${account.name} · 可用资金 ${money(account.availableFunds)} 元` : '选择账户'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {stock || active ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/30 text-[13px]">
              <span className="font-mono text-muted-foreground">{active?.symbol}</span>
              <span className="text-foreground">{active?.name}</span>
              {active && active.quantity > 0 && (
                <span className="ml-auto text-[12px] text-muted-foreground">
                  持仓 {active.quantity} 股 · 成本 {costText(active.costPrice)}
                </span>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Label className="mb-0">搜索股票</Label>
                <div className="flex items-center gap-1">
                  {[
                    { value: '', label: '全部' },
                    { value: 'CN', label: 'A股' },
                    { value: 'HK', label: '港股' },
                    { value: 'US', label: '美股' },
                  ].map(opt => (
                    <button
                      key={opt.value || 'all'}
                      type="button"
                      onClick={() => setSearchMarket(opt.value)}
                      className={`text-[11px] px-2 py-0.5 rounded ${searchMarket === opt.value ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="代码或名称"
                  className="pl-9"
                  autoComplete="off"
                />
                {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">搜索中</span>}
                {hits.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 max-h-48 overflow-auto card shadow-lg">
                    {hits.map(hit => (
                      <button
                        key={`${hit.market}-${hit.symbol}`}
                        type="button"
                        onClick={() => chooseHit(hit)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-accent/50 text-left"
                      >
                        <span className="font-mono text-muted-foreground">{hit.symbol}</span>
                        <span>{hit.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{side === 'buy' ? '买入数量（股）' : '卖出数量（股）'}</Label>
              <Input
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder="0"
                className="font-mono"
                inputMode="numeric"
                aria-label={side === 'buy' ? '买入数量' : '卖出数量'}
              />
              {market === 'CN' && (
                <p className="mt-1 text-[11px] text-muted-foreground">A 股通常 1 手 = 100 股，这里按股填写，不强制整手。</p>
              )}
              {side === 'sell' && active && active.quantity > 0 && (
                <button
                  type="button"
                  className="mt-1 text-[11px] text-primary"
                  onClick={() => setQuantity(String(active.quantity))}
                >
                  全部 {active.quantity} 股
                </button>
              )}
            </div>
            <div>
              <Label>成交价（{priceCurrency(market)}）</Label>
              <Input
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                className="font-mono"
                inputMode="decimal"
                aria-label="成交价"
              />
            </div>
          </div>
          <div>
            <Label>手续费 <span className="text-muted-foreground/60 text-[11px]">(选填，{priceCurrency(market)})</span></Label>
            <Input
              value={fee}
              onChange={e => setFee(e.target.value)}
              placeholder="0"
              className="font-mono"
              inputMode="decimal"
              aria-label="手续费"
            />
          </div>

          {market !== 'CN' && (
            <p className="text-[12px] text-muted-foreground">
              成本按{priceCurrency(market)}记，可用资金按汇率 {preview?.fx ?? '—'} 折成人民币。
            </p>
          )}

          {preview && (
            <div className={`rounded-lg px-3 py-2 text-[12px] space-y-1 ${preview.valid ? 'bg-accent/40' : 'bg-destructive/10 text-destructive'}`}>
              {preview.valid ? (
                <>
                  <div>成交额 {money(preview.gross)} {priceCurrency(market)}</div>
                  <div>{side === 'buy' ? '预计扣款' : '预计回笼'} {money(Math.abs(preview.cashDeltaCny))} 元</div>
                  <div>
                    {preview.closed
                      ? '成交后清仓'
                      : `成交后 ${preview.nextQuantity} 股，成本 ${costText(preview.nextCost)}，总成本 ${money(preview.nextInvested || 0)} ${priceCurrency(market)}`}
                  </div>
                  <div>成交后可用 {money(preview.nextFunds)} 元</div>
                </>
              ) : (
                <div>{preview.error}</div>
              )}
            </div>
          )}
          {error && <p className="text-[12px] text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={submit} disabled={submitting || !active || !preview?.valid}>
              {submitting ? '提交中…' : side === 'buy' ? '确认买入' : '确认卖出'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
