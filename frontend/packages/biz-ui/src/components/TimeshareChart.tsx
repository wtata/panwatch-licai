import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  type IntradayClockZone,
  chartTimeZone,
  formatChartClock,
  initialIntradayClock,
  intradayClockLabel,
  intradayTimeScaleOptions,
  readUsIntradayClock,
  writeUsIntradayClock,
} from '@panwatch/biz-ui/components/chart-time'

type TrendPoint = {
  time: string
  ts: number
  price: number
  avg: number
  volume: number
}

type TrendsResponse = {
  symbol: string
  market: string
  timezone?: string
  date?: string
  prev_close?: number | null
  source?: string
  hint?: string
  points?: TrendPoint[]
}

function getLW() {
  return (window as any)?.LightweightCharts || null
}

function addLine(chart: any, LW: any, options: any) {
  if (typeof chart?.addLineSeries === 'function') return chart.addLineSeries(options)
  if (typeof chart?.addSeries === 'function' && LW?.LineSeries) return chart.addSeries(LW.LineSeries, options)
  throw new Error('Line series API not available')
}

function addHistogram(chart: any, LW: any, options: any) {
  if (typeof chart?.addHistogramSeries === 'function') return chart.addHistogramSeries(options)
  if (typeof chart?.addSeries === 'function' && LW?.HistogramSeries) return chart.addSeries(LW.HistogramSeries, options)
  throw new Error('Histogram series API not available')
}

function formatCompact(value: number): string {
  const n = Math.abs(value)
  if (n >= 100000000) return `${(value / 100000000).toFixed(2)}亿`
  if (n >= 10000) return `${(value / 10000).toFixed(1)}万`
  return value.toFixed(0)
}

export default function TimeshareChart(props: {
  symbol: string
  market: string
  refreshMs?: number
  embedded?: boolean
}) {
  const [lwReady, setLwReady] = useState(!!getLW())
  const [libError, setLibError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [points, setPoints] = useState<TrendPoint[]>([])
  const [prevClose, setPrevClose] = useState<number | null>(null)
  const [clockZone, setClockZone] = useState(() => initialIntradayClock(props.market))
  const [hint, setHint] = useState('')
  const [hover, setHover] = useState<{ x: number; y: number; point: TrendPoint } | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)

  const load = async () => {
    if (!props.symbol) return
    const reqId = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const res = await fetchAPI<TrendsResponse>(
        `/klines/${encodeURIComponent(props.symbol)}/trends?market=${encodeURIComponent(props.market || 'CN')}`,
      )
      if (reqId !== requestRef.current) return
      const raw = res.points || []
      const byTs = new Map<number, TrendPoint>()
      for (const p of raw) {
        const ts = Number(p.ts)
        const price = Number(p.price)
        if (!Number.isFinite(ts) || !Number.isFinite(price)) continue
        const sec = ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts)
        byTs.set(sec, {
          time: String(p.time || ''),
          ts: sec,
          price,
          avg: Number.isFinite(Number(p.avg)) ? Number(p.avg) : price,
          volume: Number.isFinite(Number(p.volume)) ? Number(p.volume) : 0,
        })
      }
      setPoints([...byTs.values()].sort((a, b) => a.ts - b.ts))
      setHint(String(res.hint || ''))
      setPrevClose(res.prev_close == null || Number.isNaN(Number(res.prev_close)) ? null : Number(res.prev_close))
      // 美股时区由用户切换决定，刷新不能把它打回接口里的美东。
      if (String(props.market || '').toUpperCase() !== 'US') {
        setClockZone(res.timezone || chartTimeZone(props.market))
      }
    } catch (e) {
      if (reqId !== requestRef.current) return
      setError(e instanceof Error ? e.message : '加载当日分时失败')
      setHint('')
      setPoints([])
    } finally {
      if (reqId === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (String(props.market || '').toUpperCase() === 'US') setClockZone(readUsIntradayClock())
    else setClockZone(chartTimeZone(props.market))
  }, [props.market])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbol, props.market])

  useEffect(() => {
    const refreshMs = props.refreshMs ?? 0
    if (!refreshMs || refreshMs < 5000) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void load()
    }, refreshMs)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbol, props.market, props.refreshMs])

  useEffect(() => {
    if (lwReady) return
    let cancelled = false
    const start = Date.now()
    const timer = window.setInterval(() => {
      if (cancelled) return
      if (getLW()) {
        setLwReady(true)
        window.clearInterval(timer)
        return
      }
      if (Date.now() - start > 3500) {
        setLibError(true)
        window.clearInterval(timer)
      }
    }, 200)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [lwReady])

  const latest = points.length ? points[points.length - 1] : null
  const changePct = useMemo(() => {
    if (!latest || !prevClose) return null
    return ((latest.price - prevClose) / prevClose) * 100
  }, [latest, prevClose])

  useEffect(() => {
    const LW = getLW()
    if (!LW || !lwReady || !containerRef.current || points.length === 0) return
    const container = containerRef.current
    container.innerHTML = ''
    const rootStyle = getComputedStyle(document.documentElement)
    const bg = rootStyle.getPropertyValue('--card').trim()
    const fg = rootStyle.getPropertyValue('--foreground').trim()
    const scale = intradayTimeScaleOptions(clockZone)
    const up = prevClose == null || (latest?.price ?? 0) >= prevClose
    const priceColor = up ? '#ef4444' : '#10b981'

    const chart = LW.createChart(container, {
      width: container.clientWidth,
      height: 360,
      layout: {
        background: { color: `hsl(${bg})` },
        textColor: `hsl(${fg} / 0.85)`,
      },
      rightPriceScale: { borderVisible: false },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.08)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.08)' },
      },
      crosshair: { mode: 1 },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      localization: scale.localization,
      timeScale: scale.timeScale,
    })

    const priceSeries = addLine(chart, LW, { color: priceColor, lineWidth: 2, priceLineVisible: false })
    const avgSeries = addLine(chart, LW, { color: 'rgba(245, 158, 11, 0.95)', lineWidth: 1, priceLineVisible: false })
    const volSeries = addHistogram(chart, LW, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } })

    priceSeries.setData(points.map(p => ({ time: p.ts, value: p.price })))
    avgSeries.setData(points.map(p => ({ time: p.ts, value: p.avg })))
    volSeries.setData(
      points.map((p, i) => {
        const prev = i > 0 ? points[i - 1].price : prevClose ?? p.price
        const rising = p.price >= prev
        return {
          time: p.ts,
          value: p.volume,
          color: rising ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.35)',
        }
      }),
    )
    if (prevClose != null && prevClose > 0) {
      priceSeries.createPriceLine?.({
        price: prevClose,
        color: 'rgba(148, 163, 184, 0.85)',
        lineWidth: 1,
        lineStyle: 2,
        title: '昨收',
      })
    }

    chart.subscribeCrosshairMove?.((param: any) => {
      const point = param?.point
      const ts = typeof param?.time === 'number' ? param.time : null
      if (!point || ts == null) {
        setHover(null)
        return
      }
      const inBounds = point.x >= 0 && point.y >= 0 && point.x <= container.clientWidth && point.y <= container.clientHeight
      if (!inBounds) {
        setHover(null)
        return
      }
      const found = points.find(p => p.ts === ts) || points.reduce((best, p) => (Math.abs(p.ts - ts) < Math.abs(best.ts - ts) ? p : best))
      const tooltipWidth = 180
      const tooltipHeight = 92
      let x = point.x + 12
      let y = point.y + 12
      if (x + tooltipWidth > container.clientWidth - 6) x = point.x - tooltipWidth - 12
      if (y + tooltipHeight > container.clientHeight - 6) y = point.y - tooltipHeight - 12
      setHover({
        x: Math.max(6, x),
        y: Math.max(6, y),
        point: found,
      })
    })

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth })
    })
    ro.observe(container)
    const total = points.length
    chart.timeScale().setVisibleLogicalRange({ from: -2, to: Math.max(total - 1, 0) + 2 })

    return () => {
      ro.disconnect()
      setHover(null)
      try {
        chart.remove()
      } catch {
        // ignore
      }
    }
  }, [points, lwReady, clockZone, prevClose, latest])

  const isUs = String(props.market || '').toUpperCase() === 'US'
  const zoneLabel = intradayClockLabel(props.market, clockZone)
  const up = changePct == null || changePct >= 0

  const selectUsClock = (zone: IntradayClockZone) => {
    setClockZone(zone)
    writeUsIntradayClock(zone)
  }

  return (
    <div className={props.embedded ? '' : 'card p-4 md:p-5'}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={`inline-block w-3 h-0.5 ${up ? 'bg-rose-500' : 'bg-emerald-500'}`} />
            价格
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-3 h-0.5 bg-amber-500" />
            均价
          </span>
          {isUs ? (
            <span className="inline-flex items-center gap-1.5">
              <span>{zoneLabel}</span>
              <span
                className="inline-flex rounded-md border border-border/60 bg-accent/20 p-0.5"
                role="group"
                aria-label="分时时区"
                title={clockZone === 'Asia/Shanghai' ? '当前按北京时间。美股交易日会跨过零点' : '当前按美东时间，大约 09:30–16:00'}
              >
                {([
                  ['America/New_York', '美东'],
                  ['Asia/Shanghai', '北京'],
                ] as const).map(([zone, label]) => (
                  <button
                    key={zone}
                    type="button"
                    aria-pressed={clockZone === zone}
                    className={`h-6 min-w-[40px] rounded px-2 text-[11px] transition-colors ${
                      clockZone === zone
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
                    }`}
                    onClick={() => selectUsClock(zone)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </span>
          ) : (
            <span>{zoneLabel}</span>
          )}
          {latest ? (
            <span className={`font-mono ${up ? 'text-rose-500' : 'text-emerald-500'}`}>
              {latest.price.toFixed(2)}
              {changePct != null ? `  ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%` : ''}
            </span>
          ) : null}
        </div>
        <Button variant="secondary" size="sm" className="h-7 px-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">刷新</span>
        </Button>
      </div>

      {error ? (
        <div className="text-[12px] text-rose-600 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2 mb-3">
          {error}
        </div>
      ) : null}
      {!lwReady && libError ? (
        <div className="text-[12px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
          图表库加载失败（网络受限时可能发生）。可稍后重试或检查网络/代理。
        </div>
      ) : null}

      <div className="relative">
        {loading && points.length === 0 ? (
          <div className="w-full h-[360px] rounded-xl overflow-hidden border border-border/50 animate-pulse bg-accent/20" />
        ) : points.length === 0 ? (
          <div className="w-full min-h-[220px] rounded-xl border border-border/50 flex items-center justify-center text-center text-[12px] text-muted-foreground px-6 py-8 leading-relaxed">
            {hint || (isUs ? '暂无美股当日分时' : '暂无当日分时')}
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-[360px] rounded-xl overflow-hidden border border-border/50" />
        )}
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 w-[180px] rounded-lg border border-border/60 bg-card/95 px-3 py-2 shadow-lg"
            style={{ left: `${hover.x}px`, top: `${hover.y}px` }}
          >
            <div className="text-[11px] font-medium mb-1">{formatChartClock(hover.point.ts, clockZone)} {zoneLabel}</div>
            <div className="text-[11px] text-muted-foreground space-y-0.5">
              <div>价格 <span className="font-mono text-foreground">{hover.point.price.toFixed(2)}</span></div>
              <div>均价 <span className="font-mono text-foreground">{hover.point.avg.toFixed(2)}</span></div>
              <div>成交量 <span className="font-mono text-foreground">{formatCompact(hover.point.volume)}</span></div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
