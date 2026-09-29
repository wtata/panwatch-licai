/** 与后端 position_ledger 对齐的买卖预览。现金按人民币，成本按标的币种。 */

export interface ExchangeRates {
  HKD_CNY?: number
  USD_CNY?: number
}

export interface TradePreviewInput {
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee: number
  market: string
  heldQuantity: number
  costPrice: number
  investedAmount: number | null
  availableFunds: number
  rates?: ExchangeRates
}

export interface TradePreview {
  valid: boolean
  error: string
  gross: number
  cashDeltaCny: number
  fx: number
  nextQuantity: number
  nextCost: number | null
  nextInvested: number | null
  nextFunds: number
  closed: boolean
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function fxForMarket(market: string, rates?: ExchangeRates): number {
  if (market === 'HK') {
    const rate = rates?.HKD_CNY
    return rate && rate > 0 ? rate : 1
  }
  if (market === 'US') {
    const rate = rates?.USD_CNY
    return rate && rate > 0 ? rate : 1
  }
  return 1
}

function emptyPreview(error = ''): TradePreview {
  return {
    valid: false,
    error,
    gross: 0,
    cashDeltaCny: 0,
    fx: 1,
    nextQuantity: 0,
    nextCost: null,
    nextInvested: null,
    nextFunds: 0,
    closed: false,
  }
}

export function previewTrade(input: TradePreviewInput): TradePreview {
  const quantity = input.quantity
  const price = input.price
  const fee = input.fee
  const held = input.heldQuantity
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return emptyPreview('数量必须大于 0，按股填写')
  }
  if (!Number.isFinite(price) || price <= 0) {
    return emptyPreview('成交价必须大于 0')
  }
  if (!Number.isFinite(fee) || fee < 0) {
    return emptyPreview('手续费不能为负')
  }

  const fx = fxForMarket(input.market, input.rates)
  const gross = roundMoney(price * quantity)
  const feeMoney = roundMoney(fee)
  const oldBasis = held <= 0
    ? 0
    : input.investedAmount != null
      ? roundMoney(input.investedAmount)
      : roundMoney(input.costPrice * held)
  const funds = roundMoney(input.availableFunds)

  if (input.side === 'sell') {
    if (quantity > held) {
      return emptyPreview(`卖出数量超过持仓（当前 ${held} 股）`)
    }
    if (feeMoney > gross) {
      return emptyPreview('手续费不能超过成交额')
    }
    const localNet = roundMoney(gross - feeMoney)
    const cashIn = roundMoney(localNet * fx)
    const soldBasis = quantity === held ? oldBasis : roundMoney(oldBasis * quantity / held)
    const nextInvested = roundMoney(oldBasis - soldBasis)
    const nextQuantity = held - quantity
    const closed = nextQuantity === 0
    return {
      valid: true,
      error: '',
      gross,
      cashDeltaCny: cashIn,
      fx,
      nextQuantity,
      nextCost: closed ? null : nextInvested / nextQuantity,
      nextInvested: closed ? null : nextInvested,
      nextFunds: roundMoney(funds + cashIn),
      closed,
    }
  }

  const localCost = roundMoney(gross + feeMoney)
  const cashOut = roundMoney(localCost * fx)
  if (funds < cashOut) {
    return emptyPreview(`可用资金不足：需要 ${cashOut.toFixed(2)} 元，当前可用 ${funds.toFixed(2)} 元`)
  }
  const nextInvested = roundMoney(oldBasis + localCost)
  const nextQuantity = held + quantity
  return {
    valid: true,
    error: '',
    gross,
    cashDeltaCny: -cashOut,
    fx,
    nextQuantity,
    nextCost: nextInvested / nextQuantity,
    nextInvested,
    nextFunds: roundMoney(funds - cashOut),
    closed: false,
  }
}
