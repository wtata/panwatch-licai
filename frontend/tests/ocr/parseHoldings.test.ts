import { describe, expect, it } from 'vitest'
import {
  parseHoldings,
  parseHoldingsFromText,
  parseHoldingsFromWords,
  parseSecurityCode,
  toEditableRows,
} from '@/lib/ocr/parseHoldings'
import type { OcrWord } from '@/lib/ocr/types'

function wordsFromRows(rows: string[][]): OcrWord[] {
  return rows.flatMap((cols, row) =>
    cols.map((text, col) => ({
      text,
      confidence: 88,
      bbox: { x0: col * 80, y0: row * 24, x1: col * 80 + 70, y1: row * 24 + 18 },
    })),
  )
}

const SAMPLE_TEXT = `
证券代码 证券名称 持仓数量 可卖数量 成本价 现价 最新市值 浮动盈亏
600519 贵州茅台 100 100 1423.56 1480.00 148000 5644
000858 五粮液 200 200 128.50 131.20 26240 540
300750 宁德时代 300 300 189.20 200.10 60030 3270
合计
`

describe('parseSecurityCode', () => {
  it('recognizes A-share, STAR and ETF codes', () => {
    expect(parseSecurityCode('600519')).toEqual({ symbol: '600519', market: 'CN' })
    expect(parseSecurityCode('688111')).toEqual({ symbol: '688111', market: 'CN' })
    expect(parseSecurityCode('510300')).toEqual({ symbol: '510300', market: 'CN' })
  })

  it('pads Hong Kong codes and ignores lot-like 5-digit quantities', () => {
    expect(parseSecurityCode('700')).toBeNull()
    expect(parseSecurityCode('00700')).toEqual({ symbol: '00700', market: 'HK' })
    expect(parseSecurityCode('10000')).toBeNull()
  })
})

describe('parseHoldingsFromText', () => {
  it('parses a Tonghuashun table dump into symbol/name/qty/cost', () => {
    const rows = parseHoldingsFromText(SAMPLE_TEXT)
    expect(rows.map((row) => row.symbol)).toEqual(['600519', '000858', '300750'])
    expect(rows[0]).toMatchObject({ name: '贵州茅台', quantity: 100, avgCost: 1423.56, market: 'CN' })
    expect(rows[1]).toMatchObject({ name: '五粮液', quantity: 200, avgCost: 128.5 })
    expect(rows[2]).toMatchObject({ name: '宁德时代', quantity: 300, avgCost: 189.2 })
  })

  it('parses compact card-style mobile screenshots', () => {
    const rows = parseHoldingsFromText(`
贵州茅台
600519
持仓100
成本价1423.56
`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: '600519', name: '贵州茅台', quantity: 100, avgCost: 1423.56 })
  })

  it('skips header and summary lines', () => {
    const rows = parseHoldingsFromText('证券代码 持仓数量 成本价\n合计 1000 12345')
    expect(rows).toEqual([])
  })
})

describe('parseHoldingsFromWords', () => {
  it('groups bounding boxes into rows and merges split stock codes', () => {
    const rows = parseHoldingsFromWords(wordsFromRows([
      ['证券代码', '证券名称', '持仓数量', '成本价'],
      ['600', '519', '贵州茅台', '100', '1423.56'],
      ['000858', '五粮液', '200', '128.50'],
    ]))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ symbol: '600519', name: '贵州茅台', quantity: 100, avgCost: 1423.56 })
    expect(rows[1]).toMatchObject({ symbol: '000858', name: '五粮液', quantity: 200, avgCost: 128.5 })
  })
})

describe('parseHoldings', () => {
  it('merges word and text results and flags incomplete rows', () => {
    const rows = parseHoldings({
      text: '600519 贵州茅台 100 1423.56\n000001 平安银行',
      words: wordsFromRows([['600519', '贵州茅台', '100', '1423.56']]),
    })
    expect(rows).toHaveLength(2)
    const pingAn = rows.find((row) => row.symbol === '000001')
    expect(pingAn?.warnings.some((item) => item.includes('数量') || item.includes('成本'))).toBe(true)
    const editable = toEditableRows(rows)
    expect(editable[0].selected).toBe(true)
    expect(editable[0].quantity).toBe('100')
  })
})
