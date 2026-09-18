import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { dashboardApi, disciplineApi, learningApi } from '@panwatch/api'
import OverviewPage from '@/pages/Overview'
import DisciplinePage from '@/pages/Discipline'
import LearnPage from '@/pages/Learn'

vi.mock('@panwatch/api', () => ({
  dashboardApi: {
    portfolioSummary: vi.fn(),
  },
  disciplineApi: {
    summary: vi.fn(),
    listJournal: vi.fn(),
    listRules: vi.fn(),
    createJournal: vi.fn(),
    deleteJournal: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
  },
  learningApi: {
    cards: vi.fn(),
  },
}))

describe('LearnPage', () => {
  it('renders seeded learning cards', async () => {
    vi.mocked(learningApi.cards).mockResolvedValue({
      items: [
        {
          id: 'valuation',
          kicker: '估值',
          title: '先问贵不贵，再问涨不涨',
          body: '短卡片',
          points: ['说得出贵在哪'],
        },
      ],
    })

    render(<LearnPage />)

    expect(await screen.findByRole('heading', { name: '学习' })).toBeTruthy()
    expect(await screen.findByText('先问贵不贵，再问涨不涨')).toBeTruthy()
    expect(screen.getByText('说得出贵在哪')).toBeTruthy()
  })
})

describe('OverviewPage', () => {
  beforeEach(() => {
    vi.mocked(dashboardApi.portfolioSummary).mockResolvedValue({
      accounts: [],
      total: {
        total_market_value: 0,
        total_cost: 0,
        total_pnl: 0,
        total_pnl_pct: 0,
        total_daily_pnl: 0,
        available_funds: 12000,
        total_assets: 12000,
      },
    })
    vi.mocked(disciplineApi.summary).mockResolvedValue({
      rules: [{ id: 1, text: '单票不超过 25%', enabled: true, created_at: null, updated_at: null }],
      journal: [
        {
          id: 9,
          date: '2026-09-18',
          symbol: '688195',
          type: 'review',
          text: '复盘仓位上限',
          created_at: null,
        },
      ],
    })
  })

  it('shows cash, enabled rules and recent notes without duplicating diagnostics', async () => {
    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '理财总览' })).toBeTruthy()
    expect(screen.getByText('现金 / 可用资金')).toBeTruthy()
    expect(screen.getByText('单票不超过 25%')).toBeTruthy()
    expect(screen.getByText('复盘仓位上限')).toBeTruthy()
    expect(screen.queryByText('AI 体检')).toBeNull()
  })
})

describe('DisciplinePage', () => {
  beforeEach(() => {
    vi.mocked(disciplineApi.listJournal).mockResolvedValue({ items: [] })
    vi.mocked(disciplineApi.listRules).mockResolvedValue({ items: [] })
    vi.mocked(disciplineApi.createJournal).mockResolvedValue({
      id: 1,
      date: '2026-09-18',
      symbol: '688195',
      type: 'buy',
      text: '假设估值仍便宜',
      created_at: null,
    })
  })

  it('records a journal note', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DisciplinePage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: '交易笔记' })).toBeTruthy()
    await user.type(screen.getByLabelText('相关代码'), '688195')
    await user.type(screen.getByLabelText('内容'), '假设估值仍便宜')
    await user.click(screen.getByRole('button', { name: '记一笔' }))

    await waitFor(() => {
      expect(disciplineApi.createJournal).toHaveBeenCalled()
    })
    expect(await screen.findByText('假设估值仍便宜')).toBeTruthy()
  })
})
