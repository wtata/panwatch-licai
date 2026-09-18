export interface OcrBBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrWord {
  text: string
  confidence: number
  bbox: OcrBBox
}

export interface ParsedHolding {
  symbol: string
  name: string
  market: 'CN' | 'HK' | 'US'
  quantity: number | null
  avgCost: number | null
  warnings: string[]
}

export interface EditableHoldingRow {
  id: string
  selected: boolean
  symbol: string
  name: string
  market: 'CN' | 'HK' | 'US'
  quantity: string
  avgCost: string
  warnings: string[]
}

export interface StockRef {
  id: number
  symbol: string
  name: string
  market: string
}

export interface PositionRef {
  id: number
  stock_id: number
  symbol: string
  market: string
  account_id?: number
}
