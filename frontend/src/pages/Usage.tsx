import { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { llmUsageApi, type LlmUsageItem, type LlmUsageSummary } from '@panwatch/api'
import { Badge } from '@panwatch/base-ui/components/ui/badge'

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtUsd(n: number) {
  if (!n) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

function fmtTime(iso?: string) {
  if (!iso) return '--'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function UsagePage() {
  const [summary, setSummary] = useState<LlmUsageSummary | null>(null)
  const [items, setItems] = useState<LlmUsageItem[]>([])
  const [scene, setScene] = useState('all')
  const [loading, setLoading] = useState(true)

  const load = async (nextScene = scene) => {
    setLoading(true)
    try {
      const [s, list] = await Promise.all([
        llmUsageApi.summary(30),
        llmUsageApi.list({
          scene: nextScene === 'all' ? undefined : nextScene,
          limit: 80,
        }),
      ])
      setSummary(s)
      setItems(list.items)
    } catch {
      setSummary(null)
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold flex items-center gap-2">
            <Coins className="w-5 h-5 text-primary" />
            模型消费
          </h1>
          <p className="text-[12px] text-muted-foreground mt-1">
            每次大模型调用的 token 与估算费用。费用按公开单价估算，以供应商账单为准。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="今日调用" value={String(summary?.today.calls ?? 0)} />
        <Stat label="今日 Token" value={fmtTokens(summary?.today.total_tokens ?? 0)} />
        <Stat label="今日估算" value={fmtUsd(summary?.today.cost_usd ?? 0)} />
        <Stat label="本月估算" value={fmtUsd(summary?.month.cost_usd ?? 0)} hint={`${summary?.month.calls ?? 0} 次`} />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="card p-4">
          <div className="text-[13px] font-medium mb-3">本月场景</div>
          {(summary?.by_scene || []).length === 0 && (
            <p className="text-[12px] text-muted-foreground">还没有记录。对话、截图导入、Agent 跑起来后会出现在这里。</p>
          )}
          <div className="space-y-2">
            {(summary?.by_scene || []).map((row) => (
              <div key={row.scene} className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">{row.scene_label}</span>
                <span className="font-mono">
                  {row.calls} 次 · {fmtTokens(row.total_tokens)} · {fmtUsd(row.cost_usd)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-[13px] font-medium mb-3">按日汇总</div>
          {(summary?.by_day || []).length === 0 && (
            <p className="text-[12px] text-muted-foreground">暂无按日数据。</p>
          )}
          <div className="space-y-2 max-h-56 overflow-auto">
            {(summary?.by_day || []).map((row) => (
              <div key={row.day} className="flex items-center justify-between text-[12px]">
                <span className="text-muted-foreground">{row.day}</span>
                <span className="font-mono">
                  {row.calls} 次 · {fmtTokens(row.total_tokens)} · {fmtUsd(row.cost_usd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="text-[13px] font-medium">调用明细</div>
          <select
            className="h-8 w-36 rounded-md border border-input bg-background px-2 text-[12px]"
            value={scene}
            onChange={(e) => {
              const v = e.target.value
              setScene(v)
              void load(v)
            }}
          >
            <option value="all">全部场景</option>
            {(summary?.scenes || []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        {loading && <p className="text-[12px] text-muted-foreground">加载中…</p>}
        {!loading && items.length === 0 && (
          <p className="text-[12px] text-muted-foreground">没有匹配的调用记录。</p>
        )}
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-3 py-2 border-b border-border/50 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px]">{item.scene_label}</Badge>
                  <span className="text-[12px] font-mono truncate">{item.model || '-'}</span>
                  {item.source === 'estimated' && (
                    <span className="text-[10px] text-muted-foreground">估算</span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {fmtTime(item.created_at)} · {item.operation}
                </div>
              </div>
              <div className="text-right text-[12px] font-mono whitespace-nowrap">
                <div>{item.prompt_tokens} + {item.completion_tokens}</div>
                <div className="text-muted-foreground">{fmtUsd(item.cost_usd)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-[18px] font-semibold font-mono mt-1">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}
