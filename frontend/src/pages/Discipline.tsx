import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  disciplineApi,
  type DisciplineJournalEntry,
  type DisciplineRule,
  type JournalType,
} from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'

const TYPES: { value: JournalType; label: string }[] = [
  { value: 'buy', label: '买入' },
  { value: 'reduce', label: '减仓' },
  { value: 'watch', label: '观察' },
  { value: 'review', label: '复盘' },
]

function todayIsoDate() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export default function DisciplinePage() {
  const { toast } = useToast()
  const [journal, setJournal] = useState<DisciplineJournalEntry[]>([])
  const [rules, setRules] = useState<DisciplineRule[]>([])
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(todayIsoDate())
  const [symbol, setSymbol] = useState('')
  const [type, setType] = useState<JournalType>('review')
  const [text, setText] = useState('')
  const [ruleDraft, setRuleDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [notes, ruleList] = await Promise.all([disciplineApi.listJournal(), disciplineApi.listRules()])
      setJournal(notes.items || [])
      setRules(ruleList.items || [])
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载纪律失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const submitNote = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || saving) return
    setSaving(true)
    try {
      const created = await disciplineApi.createJournal({
        date,
        symbol: symbol.trim(),
        type,
        text: text.trim(),
      })
      setJournal((prev) => [created, ...prev])
      setText('')
      toast('已记一笔', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const removeNote = async (id: number) => {
    try {
      await disciplineApi.deleteJournal(id)
      setJournal((prev) => prev.filter((j) => j.id !== id))
      toast('已删除笔记', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const addRule = async (e: FormEvent) => {
    e.preventDefault()
    if (!ruleDraft.trim()) return
    try {
      const created = await disciplineApi.createRule({ text: ruleDraft.trim(), enabled: true })
      setRules((prev) => [...prev, created])
      setRuleDraft('')
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加规则失败', 'error')
    }
  }

  const patchRule = async (id: number, patch: { text?: string; enabled?: boolean }) => {
    const prev = rules
    setRules((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    try {
      const updated = await disciplineApi.updateRule(id, patch)
      setRules((list) => list.map((r) => (r.id === id ? updated : r)))
    } catch (err) {
      setRules(prev)
      toast(err instanceof Error ? err.message : '更新规则失败', 'error')
    }
  }

  const removeRule = async (id: number) => {
    try {
      await disciplineApi.deleteRule(id)
      setRules((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除规则失败', 'error')
    }
  }

  return (
    <div className="grid gap-4 pb-10 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
      <div className="card">
        <div className="border-b border-border/60 px-4 py-3">
          <h1 className="text-[16px] font-semibold">交易笔记</h1>
        </div>
        <form className="grid gap-3 border-b border-border/60 p-4" onSubmit={submitNote}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="journal-date">日期</Label>
              <Input id="journal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="journal-symbol">相关代码</Label>
              <Input
                id="journal-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="688195，可空"
              />
            </div>
            <div>
              <Label>类型</Label>
              <Select value={type} onValueChange={(v) => setType(v as JournalType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="journal-text">内容</Label>
            <textarea
              id="journal-text"
              className="min-h-24 w-full resize-y rounded-xl border border-border bg-card px-4 py-2 text-[13px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/20"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="当时的假设、为什么现在动手、哪条规则被触发了。"
              required
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving || !text.trim()}>
              <Plus className="h-4 w-4" />
              记一笔
            </Button>
          </div>
        </form>
        {loading ? (
          <p className="p-4 text-[13px] text-muted-foreground">加载中…</p>
        ) : journal.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px] font-medium">笔记本是空的</p>
            <p className="mt-1 text-[12px] text-muted-foreground">买入、减仓、观察、复盘都值得留下假设，而不是只留下盈亏。</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {journal.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-[11px] text-muted-foreground">
                    {entry.date} · {entry.symbol || '组合'} · {TYPES.find((t) => t.value === entry.type)?.label}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-foreground">{entry.text}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeNote(entry.id)} aria-label="删除笔记">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-[16px] font-semibold">个人规则</h2>
          <span className="text-[11px] text-muted-foreground">勾选后出现在总览提醒</span>
        </div>
        <div className="p-4">
          <form className="mb-4 flex gap-2" onSubmit={addRule}>
            <Input value={ruleDraft} onChange={(e) => setRuleDraft(e.target.value)} placeholder="新规则…" />
            <Button type="submit" variant="secondary" disabled={!ruleDraft.trim()}>
              添加
            </Button>
          </form>
          {rules.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">规则被清空了。建议至少留一条仓位上限。</p>
          ) : (
            <ul className="space-y-2">
              {rules.map((rule) => (
                <li key={rule.id} className="rounded-lg border border-border/60 bg-accent/20 p-3">
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-primary"
                      checked={rule.enabled}
                      onChange={(e) => patchRule(rule.id, { enabled: e.target.checked })}
                      aria-label="启用后出现在总览"
                    />
                    <textarea
                      className="min-h-16 w-full resize-y rounded-md border border-transparent bg-transparent p-1 text-[13px] leading-6 text-foreground outline-none focus:border-primary/40"
                      value={rule.text}
                      onChange={(e) =>
                        setRules((list) => list.map((r) => (r.id === rule.id ? { ...r, text: e.target.value } : r)))
                      }
                      onBlur={(e) => {
                        const next = e.target.value.trim()
                        if (next && next !== rule.text) patchRule(rule.id, { text: next })
                      }}
                    />
                    <Button size="sm" variant="ghost" onClick={() => removeRule(rule.id)} aria-label="删除规则">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
