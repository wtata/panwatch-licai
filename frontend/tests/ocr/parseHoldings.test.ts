import { describe, expect, it } from 'vitest'
import {
  parseHoldings,
  parseHoldingsFromText,
  parseHoldingsFromWords,
  parseSecurityCode,
  preferOcrHoldings,
  sanitizeHoldings,
  toEditableRows,
} from '@/lib/ocr/parseHoldings'
import { findDarkContentBox } from '@/lib/ocr/recognize'
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
    expect(parseSecurityCode('03000')).toBeNull()
    expect(parseSecurityCode('01500')).toBeNull()
    expect(parseSecurityCode('865007')).toBeNull()
  })

  it('does not treat 1-2 letter UI fragments as US tickers', () => {
    expect(parseSecurityCode('V')).toBeNull()
    expect(parseSecurityCode('A')).toBeNull()
    expect(parseSecurityCode('O')).toBeNull()
    expect(parseSecurityCode('AAPL')).toEqual({ symbol: 'AAPL', market: 'US' })
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

  it('parses Tonghuashun app rows: 名称 盈亏 持仓 成本/现价 without codes', () => {
    const rows = parseHoldingsFromText(`
持仓份额
浙江鼎业 -82.23 700 5.362
四维图新 -15.51% 0 13.63
中国石化 34.86 100 4.401
沪电股份 -303.86 500 7.372
锦胜集团 -16.745 100 HK$529.280
华宝证券
V 维萨
`)
    expect(rows.map((row) => row.name)).toEqual(['浙江鼎业', '中国石化', '沪电股份', '锦胜集团'])
    expect(rows[0]).toMatchObject({ quantity: 700, avgCost: 5.362 })
    expect(rows[1]).toMatchObject({ quantity: 100, avgCost: 4.401 })
    expect(rows[2]).toMatchObject({ quantity: 500, avgCost: 7.372 })
    expect(rows[3]).toMatchObject({ quantity: 100, avgCost: 529.28, market: 'HK' })
  })

  it('ignores 盈亏 and keeps the upper 持仓/成本 of stacked cells', () => {
    const rows = parseHoldingsFromText(`
道氏技术 -32.17 400 17.876
-0.45% 600 18.201
浙江鼎业 -82.23 700 700 5.362 5.401
中国石化 34.86 100 100 4.401 4.550
`)
    expect(rows.map((row) => ({ name: row.name, quantity: row.quantity, avgCost: row.avgCost }))).toEqual([
      { name: '道氏技术', quantity: 400, avgCost: 17.876 },
      { name: '浙江鼎业', quantity: 700, avgCost: 5.362 },
      { name: '中国石化', quantity: 100, avgCost: 4.401 },
    ])
  })

  it('uses the top number when OCR words stack 持仓/可用 and 成本/现价', () => {
    const rows = parseHoldingsFromWords(wordsFromRows([
      ['道氏技术', '-32.17', '400', '17.876'],
      ['-0.45%', '600', '18.201'],
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: '道氏技术', quantity: 400, avgCost: 17.876 })
  })

  it('ignores account totals and duplicate qty/cost rows', () => {
    const rows = parseHoldings({
      text: `
总资产 377034.01 -15991.87
持仓 可用 市值
122643.99 250363.12 241545.85
浙江鼎业 -82.23 700 5.362
浙江鼎业 -82.23 700 5.362
数据港 -67.62 200 27.553
数据 200 27.553
`,
    })
    expect(rows.map((row) => row.name)).toEqual(['浙江鼎业', '数据港'])
    expect(rows[0]).toMatchObject({ quantity: 700, avgCost: 5.362 })
  })

  it('drops overlay leftovers and quantity-as-code rows', () => {
    const rows = parseHoldings({
      text: `
BQCCC
865007 连热电 500 7.812
001518 春光科技53.060
03000 香港证券-9.543 1.799
01500 现恒建筑 3.227
33210
陕西黑猫 -1.702 500 3.828
`,
    })
    expect(rows.map((row) => ({ name: row.name, quantity: row.quantity, avgCost: row.avgCost, symbol: row.symbol }))).toEqual([
      { name: '连热电', quantity: 500, avgCost: 7.812, symbol: '' },
      { name: '陕西黑猫', quantity: 500, avgCost: 3.828, symbol: '' },
    ])
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

  it('uses header columns so 现价/可卖数量 are not taken as 成本/持仓', () => {
    const headers = ['证券代码', '证券名称', '持仓数量', '可卖数量', '成本价', '现价', '最新市值']
    const data = ['600519', '贵州茅台', '100', '80', '1423.56', '1480.00', '148000']
    const rows = parseHoldingsFromWords(wordsFromRows([headers, data]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: '600519', name: '贵州茅台', quantity: 100, avgCost: 1423.56 })
  })
})

describe('sanitizeHoldings', () => {
  it('prefers OCR names when OCR already has a full table', () => {
    const ocr = sanitizeHoldings(parseHoldingsFromText(`
浙江鼎业 -82.23 700 5.362
中国石化 34.86 100 4.401
沪电股份 -303.86 500 7.372
陕西黑猫 -1.702 500 3.828
翠微股份 -57.58 300 11.569
数据港 -67.62 200 27.553
`))
    const vision = [
      { symbol: '002172', name: '澳洋健康', market: 'CN' as const, quantity: 700, avgCost: 58.24, warnings: [] },
      { symbol: '600028', name: '中国石化', market: 'CN' as const, quantity: 100, avgCost: 4.401, warnings: [] },
    ]
    const merged = preferOcrHoldings(ocr, vision)
    expect(merged.map((row) => row.name)).toEqual(ocr.map((row) => row.name))
    expect(merged.find((row) => row.name === '中国石化')?.symbol).toBe('600028')
    expect(merged.find((row) => row.name === '澳洋健康')).toBeUndefined()
  })

  it('drops generic name fragments like 技术/股份', () => {
    const rows = parseHoldings({
      text: `
道氏技术 -32.17 400 17.876
技术 600 17.876
数据港 -67.62 200 27.553
数据 200 27.553
翠微股份 -57.58 300 11.569
股份 200 12.7
`,
    })
    expect(rows.map((row) => row.name).sort()).toEqual(['数据港', '翠微股份', '道氏技术'].sort())
  })

  it('drops odd-lot A-share rows, two-character names, and vision-only invented names', () => {
    const ocrText = `
浙江鼎业 -82.23 700 5.362
数据港 -67.62 200 27.553
道氏技术 -32.17 400 17.876
`
    const ocr = parseHoldingsFromText(ocrText)
    const vision = [
      { symbol: '300071', name: '福石控股', market: 'CN' as const, quantity: 449, avgCost: 4.134, warnings: [] },
      { symbol: '300164', name: '通源石油', market: 'CN' as const, quantity: 300, avgCost: 9.703, warnings: [] },
      { symbol: '', name: '多多', market: 'CN' as const, quantity: 100, avgCost: 36.208, warnings: [] },
      { symbol: '300409', name: '道氏技术', market: 'CN' as const, quantity: 600, avgCost: 17.876, warnings: [] },
      { symbol: '603881', name: '数据港', market: 'CN' as const, quantity: 200, avgCost: 27.553, warnings: [] },
    ]
    expect(sanitizeHoldings([
      { symbol: '300071', name: '福石控股', market: 'CN', quantity: 449, avgCost: 4.134, warnings: [] },
      { symbol: '', name: '多多', market: 'CN', quantity: 100, avgCost: 36.208, warnings: [] },
      { symbol: '603881', name: '数据港', market: 'CN', quantity: 200, avgCost: 27.553, warnings: [] },
    ]).map((row) => row.name)).toEqual(['数据港'])

    const merged = preferOcrHoldings(ocr, vision, ocrText)
    expect(merged.map((row) => row.name)).toEqual(['浙江鼎业', '数据港', '道氏技术'])
    expect(merged.find((row) => row.name === '道氏技术')).toMatchObject({ quantity: 400, symbol: '300409' })
    expect(merged.find((row) => row.name === '福石控股')).toBeUndefined()
    expect(merged.find((row) => row.name === '通源石油')).toBeUndefined()

    const visionOnly = preferOcrHoldings([], vision, ocrText)
    expect(visionOnly.map((row) => row.name)).toEqual(['道氏技术', '数据港'])
  })
})

describe('findDarkContentBox', () => {
  it('crops a dark holdings strip on a mostly white canvas', () => {
    const width = 200
    const height = 120
    const box = findDarkContentBox(width, height, (x) => (x >= 120 ? 20 : 250))
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(100)
    expect(box!.w).toBeLessThan(110)
  })
})

describe('parseHoldings', () => {
  it('merges word and text results and keeps complete rows', () => {
    const rows = parseHoldings({
      text: '600519 贵州茅台 100 1423.56\n000001 平安银行',
      words: wordsFromRows([['600519', '贵州茅台', '100', '1423.56']]),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: '600519', name: '贵州茅台', quantity: 100 })
    const editable = toEditableRows(rows)
    expect(editable[0].selected).toBe(true)
    expect(editable[0].quantity).toBe('100')
  })
})
