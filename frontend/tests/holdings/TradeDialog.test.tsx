import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import DeletePositionDialog from '@/components/holdings/DeletePositionDialog'
import TradeDialog from '@/components/holdings/TradeDialog'
import TradeHistoryDialog from '@/components/holdings/TradeHistoryDialog'

const stock = {
  stockId: 2,
  symbol: '600519',
  name: '贵州茅台',
  market: 'CN',
  positionId: 9,
  quantity: 100,
  costPrice: 10,
  investedAmount: 1000,
  currentPrice: 12,
}

describe('持仓买卖对话框', () => {
  it('卖出按股提交数量、价格和手续费，并提示 A 股 1 手', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <TradeDialog
        open
        onOpenChange={vi.fn()}
        side="sell"
        account={{ id: 1, name: '招商证券', availableFunds: 1000, positions: [stock] }}
        stock={stock}
        onSearch={async () => []}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.getByText(/1 手 = 100 股/)).toBeTruthy()
    await user.type(screen.getByLabelText('卖出数量'), '50')
    await user.type(screen.getByLabelText('手续费'), '1')
    await user.click(screen.getByRole('button', { name: '确认卖出' }))

    expect(onSubmit).toHaveBeenCalledWith({
      side: 'sell',
      accountId: 1,
      positionId: 9,
      stockId: 2,
      symbol: '600519',
      name: '贵州茅台',
      market: 'CN',
      quantity: 50,
      price: 12,
      fee: 1,
    })
  })

  it('资金不足时不提交买入', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <TradeDialog
        open
        onOpenChange={vi.fn()}
        side="buy"
        account={{ id: 1, name: '招商证券', availableFunds: 100, positions: [] }}
        stock={{ ...stock, positionId: null, quantity: 0, costPrice: 0, investedAmount: null, currentPrice: null }}
        onSearch={async () => []}
        onSubmit={onSubmit}
      />,
    )

    await user.type(screen.getByLabelText('买入数量'), '100')
    await user.type(screen.getByLabelText('成交价'), '10')
    expect(screen.getByText(/可用资金不足/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '确认买入' }) as HTMLButtonElement).disabled).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('清空持仓对话框', () => {
  it('默认不回笼现金，勾选后才按现价卖出', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const view = render(
      <DeletePositionDialog
        open
        onOpenChange={vi.fn()}
        symbol="600519"
        name="贵州茅台"
        market="CN"
        quantity={100}
        currentPrice={12}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText(/默认不会当作卖出/)).toBeTruthy()
    const box = screen.getByRole('checkbox', { name: /同时按现价回笼/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await user.click(screen.getByRole('button', { name: '确认清空' }))
    expect(onConfirm).toHaveBeenCalledWith(false)

    view.rerender(
      <DeletePositionDialog
        open
        onOpenChange={vi.fn()}
        symbol="600519"
        name="贵州茅台"
        market="CN"
        quantity={100}
        currentPrice={12}
        onConfirm={onConfirm}
      />,
    )
    await user.click(screen.getByRole('checkbox', { name: /同时按现价回笼/ }))
    await user.click(screen.getByRole('button', { name: '确认清空' }))
    expect(onConfirm).toHaveBeenLastCalledWith(true)
  })
})

describe('买卖流水', () => {
  it('展示方向、成交和现金仓位影响', () => {
    render(
      <TradeHistoryDialog
        open
        onOpenChange={vi.fn()}
        trades={[{
          id: 1,
          traded_at: '2026-09-23 12:00:00',
          account_name: '招商证券',
          stock_symbol: '600519',
          stock_name: '贵州茅台',
          stock_market: 'CN',
          side: 'buy',
          quantity: 100,
          price: 10.05,
          fee: 5,
          amount: 1000,
          cash_delta: -1005,
          fx_rate: 1,
          position_quantity_before: 0,
          position_quantity_after: 100,
          cost_price_before: null,
          cost_price_after: 10.05,
          available_funds_before: 10000,
          available_funds_after: 8995,
          note: '',
        }]}
        loading={false}
        error=""
      />,
    )

    expect(screen.getByText('买入')).toBeTruthy()
    expect(screen.getByText(/现金 -1,?005\.00 元/)).toBeTruthy()
    expect(screen.getByText(/仓位 0 → 100 股/)).toBeTruthy()
  })
})
