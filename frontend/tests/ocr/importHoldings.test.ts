import { describe, expect, it, vi } from 'vitest'
import { commitHoldingImport, enrichRowFromSearch, parseRowNumbers } from '@/lib/ocr/importHoldings'
import type { EditableHoldingRow } from '@/lib/ocr/types'

function row(partial: Partial<EditableHoldingRow> & Pick<EditableHoldingRow, 'symbol'>): EditableHoldingRow {
  return {
    id: partial.id || partial.symbol,
    selected: partial.selected ?? true,
    symbol: partial.symbol,
    name: partial.name || partial.symbol,
    market: partial.market || 'CN',
    quantity: partial.quantity ?? '100',
    avgCost: partial.avgCost ?? '10.5',
    warnings: partial.warnings || [],
  }
}

describe('enrichRowFromSearch', () => {
  it('fills code by Chinese name when screenshot has no symbol', async () => {
    const searchStocks = vi.fn(async () => [
      { symbol: '603955', name: '浙江鼎业', market: 'CN' },
    ])
    const row = await enrichRowFromSearch(
      {
        id: '1',
        selected: true,
        symbol: '',
        name: '浙江鼎业',
        market: 'CN',
        quantity: '700',
        avgCost: '5.362',
        warnings: ['未识别到证券代码，将按名称匹配'],
      },
      searchStocks,
    )
    expect(searchStocks).toHaveBeenCalledWith('浙江鼎业', '')
    expect(row.symbol).toBe('603955')
    expect(row.warnings).toEqual([])
  })

  it('does not overwrite OCR name with a mismatched code lookup', async () => {
    const searchStocks = vi.fn(async (query: string) => {
      if (query === '002172') return [{ symbol: '002172', name: '澳洋健康', market: 'CN' }]
      if (query === '浙江鼎业') return [{ symbol: '603955', name: '浙江鼎业', market: 'CN' }]
      return []
    })
    const row = await enrichRowFromSearch(
      {
        id: '2',
        selected: true,
        symbol: '002172',
        name: '浙江鼎业',
        market: 'CN',
        quantity: '700',
        avgCost: '5.362',
        warnings: [],
      },
      searchStocks,
    )
    expect(row.symbol).toBe('603955')
    expect(row.name).toBe('浙江鼎业')
  })
})

describe('parseRowNumbers', () => {
  it('rejects missing quantity or cost', () => {
    expect(parseRowNumbers(row({ symbol: '600519', quantity: '', avgCost: '10' }))).toEqual({ error: '持仓数量无效' })
    expect(parseRowNumbers(row({ symbol: '600519', quantity: '100', avgCost: '0' }))).toEqual({ error: '成本价无效' })
  })
})

describe('commitHoldingImport', () => {
  it('creates missing stocks/positions and updates existing ones', async () => {
    const createStock = vi.fn(async (payload: { symbol: string; name: string; market: string }) => ({
      id: 9,
      ...payload,
    }))
    const createPosition = vi.fn(async () => undefined)
    const updatePosition = vi.fn(async () => undefined)
    const result = await commitHoldingImport({
      accountId: 1,
      existingStocks: [{ id: 1, symbol: '600519', name: '贵州茅台', market: 'CN' }],
      existingPositions: [{ id: 11, stock_id: 1, symbol: '600519', market: 'CN', account_id: 1 }],
      rows: [
        row({ symbol: '600519', name: '贵州茅台', quantity: '200', avgCost: '1500' }),
        row({ symbol: '000858', name: '五粮液', quantity: '300', avgCost: '128.5' }),
        row({ symbol: '300750', selected: false }),
        row({ symbol: '000001', quantity: '', avgCost: '10' }),
      ],
      deps: {
        searchStocks: vi.fn(),
        listStocks: vi.fn(async () => []),
        createStock,
        createPosition,
        updatePosition,
      },
    })

    expect(updatePosition).toHaveBeenCalledWith(11, { cost_price: 1500, quantity: 200 })
    expect(createStock).toHaveBeenCalledWith({ symbol: '000858', name: '五粮液', market: 'CN' })
    expect(createPosition).toHaveBeenCalledWith({
      account_id: 1,
      stock_id: 9,
      cost_price: 128.5,
      quantity: 300,
    })
    expect(result).toMatchObject({ created: 1, updated: 1 })
    expect(result.failed).toEqual([{ symbol: '000001', name: '000001', error: '持仓数量无效' }])
  })

  it('recovers when createStock reports the symbol already exists', async () => {
    const result = await commitHoldingImport({
      accountId: 2,
      existingStocks: [],
      existingPositions: [],
      rows: [row({ symbol: '601318', name: '中国平安' })],
      deps: {
        searchStocks: vi.fn(),
        listStocks: vi.fn(async () => [{ id: 4, symbol: '601318', name: '中国平安', market: 'CN' }]),
        createStock: vi.fn(async () => {
          throw new Error('股票 601318 已存在')
        }),
        createPosition: vi.fn(async () => undefined),
        updatePosition: vi.fn(),
      },
    })
    expect(result.created).toBe(1)
    expect(result.failed).toEqual([])
  })
})
