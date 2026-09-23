import { describe, expect, it } from 'vitest'

import { previewTrade } from '@/components/holdings/tradePreview'

describe('previewTrade', () => {
  it('买入把手续费计入成本并从可用资金扣除', () => {
    const preview = previewTrade({
      side: 'buy',
      quantity: 100,
      price: 10,
      fee: 5,
      market: 'CN',
      heldQuantity: 0,
      costPrice: 0,
      investedAmount: null,
      availableFunds: 10000,
    })
    expect(preview.valid).toBe(true)
    expect(preview.cashDeltaCny).toBe(-1005)
    expect(preview.nextQuantity).toBe(100)
    expect(preview.nextInvested).toBe(1005)
    expect(preview.nextCost).toBe(10.05)
    expect(preview.nextFunds).toBe(8995)
  })

  it('加仓后重算加权成本，部分卖出保留剩余成本并扣除手续费', () => {
    const added = previewTrade({
      side: 'buy',
      quantity: 100,
      price: 20,
      fee: 0,
      market: 'CN',
      heldQuantity: 100,
      costPrice: 10.05,
      investedAmount: 1005,
      availableFunds: 8995,
    })
    expect(added.nextQuantity).toBe(200)
    expect(added.nextInvested).toBe(3005)
    expect(added.nextCost).toBe(15.025)
    expect(added.nextFunds).toBe(6995)

    const sold = previewTrade({
      side: 'sell',
      quantity: 100,
      price: 18,
      fee: 10,
      market: 'CN',
      heldQuantity: 200,
      costPrice: 15.025,
      investedAmount: 3005,
      availableFunds: 6995,
    })
    expect(sold.valid).toBe(true)
    expect(sold.cashDeltaCny).toBe(1790)
    expect(sold.nextQuantity).toBe(100)
    expect(sold.nextInvested).toBe(1502.5)
    expect(sold.nextCost).toBe(15.025)
    expect(sold.nextFunds).toBe(8785)
    expect(sold.closed).toBe(false)
  })

  it('卖光标记清仓，资金不足给出明确错误', () => {
    const closed = previewTrade({
      side: 'sell',
      quantity: 100,
      price: 16,
      fee: 1,
      market: 'CN',
      heldQuantity: 100,
      costPrice: 10,
      investedAmount: 1000,
      availableFunds: 1000,
    })
    expect(closed.closed).toBe(true)
    expect(closed.nextFunds).toBe(2599)
    expect(closed.nextCost).toBeNull()

    const short = previewTrade({
      side: 'buy',
      quantity: 100,
      price: 10,
      fee: 0,
      market: 'CN',
      heldQuantity: 0,
      costPrice: 0,
      investedAmount: null,
      availableFunds: 100,
    })
    expect(short.valid).toBe(false)
    expect(short.error).toContain('可用资金不足')
  })
})
