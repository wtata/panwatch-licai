import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RefreshCw, Wallet, BookOpen } from 'lucide-react'
import {
  dashboardApi,
  disciplineApi,
  type DashboardAccountSummary,
  type DashboardPortfolioSummary,
  type DisciplineJournalEntry,
  type DisciplineRule,
} from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Badge } from '@panwatch/base-ui/components/ui/badge'

type OverviewPosition = {
  id: number
  symbol: string
  name: string
  market: string
  costCny: number
  marketValueCny: number
  pnl: number | null
  pnlPct: number | null
  price: number | null
  usedCostFallback: boolean
}

const MARKET_LABEL: Record<string, string> = { CN: 'A股', HK: '港股', US: '美股' }
const MARKET_COLOR: Record<string, string> = {
  CN: 'hsl(var(--primary))',
  HK: '#f97316',
  US: '#10b981',
  CASH: 'hsl(var(--muted-foreground) / 0.55)',
}

const JOURNAL_LABEL: Record<string, string> = {
  buy: '买入',
  reduce: '减仓',
  watch: '观察',
  review: '复盘',
}

function fmtCny(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return `¥${Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

function fmtSignedCny(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return '--'
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return `${sign}¥${Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
}

function fmtPct(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

function pnlClass(v?: number | null): string {
  if (v == null || v === 0) return 'text-muted-foreground'
  return v > 0 ? 'text-rose-500' : 'text-emerald-500'
}

function flattenPositions(summary: DashboardPortfolioSummary | null): OverviewPosition[] {
  const accounts: DashboardAccountSummary[] = summary?.accounts || []
  const rows: OverviewPosition[] = []
  for (const acc of accounts) {
    for (const pos of acc.positions || []) {
      const raw = pos as DashboardAccountSummary['positions'][number] & {
        market_value_cny?: number | null
        pnl?: number | null
        pnl_pct?: number | null
        exchange_rate?: number | null
      }
      const rate = raw.exchange_rate && raw.exchange_rate > 0 ? raw.exchange_rate : 1
      const costCny = (raw.cost_price || 0) * (raw.quantity || 0) * rate
      const quoted = raw.market_value_cny
      const usedCostFallback = quoted == null || !Number.isFinite(quoted)
      const marketValueCny = usedCostFallback ? costCny : Number(quoted)
      rows.push({
        id: raw.id,
        symbol: raw.symbol,
        name: raw.name,
        market: raw.market,
        costCny,
        marketValueCny,
        pnl: usedCostFallback ? null : raw.pnl ?? marketValueCny - costCny,
        pnlPct: usedCostFallback ? null : raw.pnl_pct ?? null,
        price: raw.current_price,
        usedCostFallback,
      })
    }
  }
  return rows.sort((a, b) => b.marketValueCny - a.marketValueCny)
}

export default function OverviewPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<DashboardPortfolioSummary | null>(null)
  const [rules, setRules] = useState<DisciplineRule[]>([])
  const [journal, setJournal] = useState<DisciplineJournalEntry[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const [ps, ds] = await Promise.allSettled([
      dashboardApi.portfolioSummary({ include_quotes: true }),
      disciplineApi.summary(),
    ])
    if (ps.status === 'fulfilled') setSummary(ps.value)
    if (ds.status === 'fulfilled') {
      setRules(ds.value.rules || [])
      setJournal(ds.value.journal || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const positions = useMemo(() => flattenPositions(summary), [summary])
  const cash = summary?.total?.available_funds ?? 0
  const investedMv = positions.reduce((s, p) => s + p.marketValueCny, 0)
  const investedCost = positions.reduce((s, p) => s + p.costCny, 0)
  const quotedPnl = summary?.total?.total_pnl
  const pnl = quotedPnl != null && Number.isFinite(quotedPnl) ? quotedPnl : investedMv - investedCost
  const pnlPct = investedCost > 0 ? (pnl / investedCost) * 100 : null
  const dailyPnl = summary?.total?.total_daily_pnl ?? null
  const totalMv = investedMv + cash
  const usedCostFallback = positions.some((p) => p.usedCostFallback)
  const fx = summary?.exchange_rates

  const byWeight = useMemo(
    () =>
      positions.map((p) => ({
        ...p,
        weight: investedMv > 0 ? (p.marketValueCny / investedMv) * 100 : 0,
      })),
    [positions, investedMv],
  )

  const pie = useMemo(() => {
    const buckets: Record<string, number> = { CN: 0, HK: 0, US: 0 }
    for (const p of positions) {
      if (p.market === 'HK' || p.market === 'US') buckets[p.market] += p.marketValueCny
      else buckets.CN += p.marketValueCny
    }
    return [
      { name: 'A股', key: 'CN', value: buckets.CN, fill: MARKET_COLOR.CN },
      { name: '港股', key: 'HK', value: buckets.HK, fill: MARKET_COLOR.HK },
      { name: '美股', key: 'US', value: buckets.US, fill: MARKET_COLOR.US },
      { name: '现金', key: 'CASH', value: cash, fill: MARKET_COLOR.CASH },
    ].filter((d) => d.value > 0)
  }, [positions, cash])

  const pieTotal = pie.reduce((s, d) => s + d.value, 0)
  const conic = pie
    .reduce<{ parts: string[]; acc: number }>(
      (st, d) => {
        const next = st.acc + (pieTotal > 0 ? (d.value / pieTotal) * 100 : 0)
        st.parts.push(`${d.fill} ${st.acc}% ${next}%`)
        st.acc = next
        return st
      },
      { parts: [], acc: 0 },
    )
    .parts.join(', ')

  return (
    <div className="space-y-4 pb-10">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">理财总览</h1>
          <p className="mt-1 text-[12px] text-muted-foreground">
            组合数字来自持仓账户；纪律提醒来自你启用的规则。盯盘信号仍在首页。
          </p>
        </div>
        <Button onClick={load} disabled={loading} size="sm" variant="ghost" className="h-7 px-2">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="总市值（含现金）" value={fmtCny(totalMv)} hint="人民币口径" />
        <StatCard label="持仓成本" value={fmtCny(investedCost)} hint="按汇率折算" />
        <StatCard
          label="持仓浮盈亏"
          value={<span className={pnlClass(pnl)}>{`${fmtSignedCny(pnl)}  ${fmtPct(pnlPct)}`}</span>}
        />
        <StatCard
          label="现金 / 可用资金"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              {fmtCny(cash)}
            </span>
          }
          hint="来自启用账户，可在持仓页修改"
        />
        <StatCard
          label="日内估算"
          value={
            dailyPnl == null ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className={pnlClass(dailyPnl)}>{fmtSignedCny(dailyPnl)}</span>
            )
          }
          hint={dailyPnl == null ? '需有效昨收行情' : '相对昨收 × 持仓'}
        />
      </section>

      {usedCostFallback ? (
        <p className="text-[12px] text-muted-foreground">部分标的无行情，市值暂按成本估算。</p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="card">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <h2 className="text-[14px] font-semibold">市场配置</h2>
            <span className="text-[11px] text-muted-foreground">
              {fx?.USD_CNY ? `USD/CNY ${fx.USD_CNY.toFixed(2)}` : ''}
              {fx?.HKD_CNY ? `${fx?.USD_CNY ? ' · ' : ''}HKD/CNY ${fx.HKD_CNY.toFixed(2)}` : ''}
            </span>
          </div>
          <div className="flex min-h-64 items-center justify-center p-4">
            {pie.length === 0 ? (
              <EmptyHint title="还没有市值可画" body="添加持仓或填写账户可用资金后，这里会显示市场与现金占比。" />
            ) : (
              <div
                className="relative h-40 w-40 rounded-full"
                style={{ background: `conic-gradient(${conic})` }}
                aria-label="市场配置占比"
              >
                <div className="absolute inset-6 rounded-full bg-card" />
              </div>
            )}
          </div>
          <ul className="flex flex-wrap gap-4 border-t border-border/60 px-4 py-3 text-[12px] text-muted-foreground">
            {pie.map((d) => (
              <li key={d.key} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: d.fill }} />
                {d.name} {fmtCny(d.value)}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <h2 className="text-[14px] font-semibold">持仓权重</h2>
            <Link className="text-[12px] text-primary hover:underline" to="/portfolio">
              全部持仓
            </Link>
          </div>
          {byWeight.length === 0 ? (
            <div className="p-4">
              <EmptyHint
                title="暂无持仓"
                body="先录入仓位，权重会按人民币市值自动计算。"
                actionLabel="去添加持仓"
                onAction={() => navigate('/portfolio')}
              />
            </div>
          ) : (
            <div className="space-y-3 px-4 py-4">
              {byWeight.map((row) => (
                <div key={row.id}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[13px]">
                    <span className="truncate text-foreground">
                      {row.name}
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">{row.symbol}</span>
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">{row.weight.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-accent">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(row.weight, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-semibold">持仓速览</h2>
          <span className="text-[11px] text-muted-foreground">人民币市值</span>
        </div>
        {byWeight.length === 0 ? (
          <div className="p-4">
            <EmptyHint title="空仓" body="从持仓页添加第一笔。" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/60 text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">标的</th>
                  <th className="px-4 py-2 font-medium">市场</th>
                  <th className="px-4 py-2 text-right font-medium">现价</th>
                  <th className="px-4 py-2 text-right font-medium">市值</th>
                  <th className="px-4 py-2 text-right font-medium">浮盈亏</th>
                  <th className="px-4 py-2 text-right font-medium">权重</th>
                </tr>
              </thead>
              <tbody>
                {byWeight.map((row) => (
                  <tr key={row.id} className="border-b border-border/40 last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground">{row.name}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">{row.symbol}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="secondary">{MARKET_LABEL[row.market] || row.market}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {row.price != null ? row.price.toFixed(2) : '—'}
                      {row.usedCostFallback ? (
                        <div className="text-[11px] text-muted-foreground">按成本</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtCny(row.marketValueCny)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${pnlClass(row.pnl)}`}>
                      {row.pnl == null ? '—' : `${fmtSignedCny(row.pnl)} ${fmtPct(row.pnlPct)}`}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{row.weight.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-semibold">纪律提醒 / 最近笔记</h2>
          <Link className="text-[12px] text-primary hover:underline" to="/discipline">
            打开纪律
          </Link>
        </div>
        <div className="grid gap-0 md:grid-cols-2">
          <ul className="space-y-2 border-b border-border/60 p-4 md:border-b-0 md:border-r">
            {rules.length === 0 ? (
              <li className="text-[13px] text-muted-foreground">尚未启用任何规则。</li>
            ) : (
              rules.slice(0, 4).map((r) => (
                <li key={r.id} className="text-[13px] leading-6 text-foreground">
                  <span className="mr-2 text-primary">▸</span>
                  {r.text}
                </li>
              ))
            )}
          </ul>
          <ul className="space-y-3 p-4">
            {journal.length === 0 ? (
              <li className="text-[13px] text-muted-foreground">还没有笔记。买、减、观察、复盘都可以记一笔。</li>
            ) : (
              journal.map((j) => (
                <li key={j.id}>
                  <p className="text-[11px] text-muted-foreground">
                    {j.date} · {j.symbol || '组合'} · {JOURNAL_LABEL[j.type] || j.type}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[13px] text-foreground">{j.text}</p>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="flex justify-end border-t border-border/60 px-4 py-2">
          <Link
            to="/learn"
            className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <BookOpen className="h-3.5 w-3.5" />
            学习卡片
          </Link>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</div>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  )
}

function EmptyHint({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="py-6 text-center">
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[12px] text-muted-foreground">{body}</p>
      {actionLabel && onAction ? (
        <Button className="mt-3" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
