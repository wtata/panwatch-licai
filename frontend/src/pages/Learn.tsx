import { useEffect, useState } from 'react'
import { learningApi, type LearningCard } from '@panwatch/api'

export default function LearnPage() {
  const [cards, setCards] = useState<LearningCard[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    learningApi
      .cards()
      .then((res) => setCards(res.items || []))
      .catch((e) => setError(e instanceof Error ? e.message : '加载学习卡片失败'))
  }, [])

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">学习</h1>
        <p className="mt-2 max-w-3xl text-[13px] leading-6 text-muted-foreground">
          这里不是荐股，也不是交易信号。几张短卡片，用来在动手前把估值、仓位、做 T 和复盘的边界再看一眼。
        </p>
      </div>
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {cards.map((card) => (
          <article key={card.id} className="card flex flex-col">
            <div className="border-b border-border/60 px-4 py-3">
              <p className="text-[11px] tracking-[0.16em] text-primary">{card.kicker}</p>
              <h2 className="mt-1 text-[15px] font-medium text-foreground">{card.title}</h2>
            </div>
            <p className="flex-1 px-4 py-3 text-[13px] leading-7 text-muted-foreground">{card.body}</p>
            <ul className="space-y-1.5 border-t border-border/60 px-4 py-3">
              {card.points.map((p) => (
                <li key={p} className="text-[13px] text-foreground">
                  <span className="mr-2 text-primary">▸</span>
                  {p}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </div>
  )
}
