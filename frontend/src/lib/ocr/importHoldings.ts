import { inferMarket, normalizeSymbol, parseSecurityCode, cleanStockName, namesCompatible } from './parseHoldings'
import type { EditableHoldingRow, PositionRef, StockRef } from './types'

export interface SearchHit {
  symbol: string
  name: string
  market: string
}

export interface HoldingImportDeps {
  searchStocks: (query: string, market: string) => Promise<SearchHit[]>
  listStocks: () => Promise<StockRef[]>
  createStock: (payload: { symbol: string; name: string; market: string }) => Promise<StockRef>
  createPosition: (payload: { account_id: number; stock_id: number; cost_price: number; quantity: number }) => Promise<void>
  updatePosition: (id: number, payload: { cost_price: number; quantity: number }) => Promise<void>
}

export interface HoldingImportSuccess {
  symbol: string
  name: string
  action: 'created' | 'updated'
}

export interface HoldingImportFailure {
  symbol: string
  name: string
  error: string
}

export interface HoldingImportResult {
  created: number
  updated: number
  failed: HoldingImportFailure[]
  succeeded: HoldingImportSuccess[]
}

export function parseRowNumbers(row: EditableHoldingRow): { quantity: number; avgCost: number } | { error: string } {
  const symbol = row.symbol.trim()
  if (!symbol) return { error: '缺少证券代码' }
  const quantity = Number.parseInt(String(row.quantity).replace(/[,\s]/g, ''), 10)
  const avgCost = Number.parseFloat(String(row.avgCost).replace(/[,\s]/g, ''))
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: '持仓数量无效' }
  if (!Number.isFinite(avgCost) || avgCost <= 0) return { error: '成本价无效' }
  return { quantity, avgCost }
}

function sameSymbol(a: string, aMarket: string, b: string, bMarket: string): boolean {
  const marketA = (aMarket || inferMarket(a)).toUpperCase()
  const marketB = (bMarket || inferMarket(b)).toUpperCase()
  if (marketA !== marketB) return false
  return normalizeSymbol(a, marketA as 'CN' | 'HK' | 'US') === normalizeSymbol(b, marketB as 'CN' | 'HK' | 'US')
}

export async function enrichRowFromSearch(
  row: EditableHoldingRow,
  searchStocks: HoldingImportDeps['searchStocks'],
): Promise<EditableHoldingRow> {
  const parsedCode = parseSecurityCode(row.symbol)
  const nameQuery = cleanStockName(row.name)
  try {
    if (parsedCode) {
      const symbol = normalizeSymbol(parsedCode.symbol, parsedCode.market)
      const hits = await searchStocks(symbol, parsedCode.market)
      const exact = hits.find((hit) => sameSymbol(hit.symbol, hit.market, symbol, parsedCode.market))
      if (exact && namesCompatible(row.name, exact.name)) {
        return {
          ...row,
          symbol: normalizeSymbol(exact.symbol, (exact.market as EditableHoldingRow['market']) || parsedCode.market),
          name: exact.name || row.name,
          market: (exact.market as EditableHoldingRow['market']) || parsedCode.market,
        }
      }
      if (exact && nameQuery && !namesCompatible(row.name, exact.name)) {
        const nameHits = await searchStocks(nameQuery, '')
        const exactName = nameHits.find((hit) => hit.name === nameQuery)
        if (exactName) {
          return {
            ...row,
            symbol: normalizeSymbol(exactName.symbol, (exactName.market as EditableHoldingRow['market']) || inferMarket(exactName.symbol)),
            name: exactName.name || nameQuery,
            market: (exactName.market as EditableHoldingRow['market']) || inferMarket(exactName.symbol),
            warnings: row.warnings.filter((item) => !item.includes('证券代码')),
          }
        }
        return {
          ...row,
          symbol: '',
          selected: false,
          warnings: [...row.warnings.filter((item) => !item.includes('未能精确')), '代码与名称不一致，请手选'],
        }
      }
    }
    if (!nameQuery) {
      return parsedCode
        ? { ...row, symbol: normalizeSymbol(parsedCode.symbol, parsedCode.market), market: parsedCode.market }
        : row
    }
    const nameHits = await searchStocks(nameQuery, '')
    const exactName = nameHits.find((hit) => hit.name === nameQuery)
    if (!exactName) {
      return parsedCode
        ? { ...row, symbol: normalizeSymbol(parsedCode.symbol, parsedCode.market), market: parsedCode.market }
        : { ...row, selected: false, warnings: [...row.warnings.filter((item) => !item.includes('未能精确')), '未能精确匹配证券代码，请手选'] }
    }
    return {
      ...row,
      symbol: normalizeSymbol(exactName.symbol, (exactName.market as EditableHoldingRow['market']) || inferMarket(exactName.symbol)),
      name: exactName.name || nameQuery,
      market: (exactName.market as EditableHoldingRow['market']) || inferMarket(exactName.symbol),
      warnings: row.warnings.filter((item) => !item.includes('证券代码')),
    }
  } catch {
    return parsedCode
      ? { ...row, symbol: normalizeSymbol(parsedCode.symbol, parsedCode.market), market: parsedCode.market }
      : row
  }
}

async function ensureStock(
  row: EditableHoldingRow,
  existing: StockRef[],
  deps: HoldingImportDeps,
): Promise<StockRef> {
  const market = row.market || inferMarket(row.symbol)
  const symbol = normalizeSymbol(row.symbol, market)
  const local = existing.find((stock) => sameSymbol(stock.symbol, stock.market, symbol, market))
  if (local) return local

  const name = row.name.trim() || symbol
  try {
    return await deps.createStock({ symbol, name, market })
  } catch (error) {
    const listed = await deps.listStocks()
    const found = listed.find((stock) => sameSymbol(stock.symbol, stock.market, symbol, market))
    if (found) return found
    throw error
  }
}

export async function commitHoldingImport(options: {
  accountId: number
  rows: EditableHoldingRow[]
  existingStocks: StockRef[]
  existingPositions: PositionRef[]
  deps: HoldingImportDeps
}): Promise<HoldingImportResult> {
  const selected = options.rows.filter((row) => row.selected)
  const succeeded: HoldingImportSuccess[] = []
  const failed: HoldingImportFailure[] = []
  let stocks = [...options.existingStocks]
  const positions = [...options.existingPositions]

  for (const row of selected) {
    const parsed = parseRowNumbers(row)
    if ('error' in parsed) {
      failed.push({ symbol: row.symbol || '未知', name: row.name, error: parsed.error })
      continue
    }
    try {
      const stock = await ensureStock(row, stocks, options.deps)
      if (!stocks.some((item) => item.id === stock.id)) stocks = [...stocks, stock]
      const existing = positions.find((pos) => pos.stock_id === stock.id)
        || positions.find((pos) => sameSymbol(pos.symbol, pos.market, stock.symbol, stock.market))
      if (existing) {
        await options.deps.updatePosition(existing.id, {
          cost_price: parsed.avgCost,
          quantity: parsed.quantity,
        })
        existing.stock_id = stock.id
        existing.symbol = stock.symbol
        existing.market = stock.market
        succeeded.push({ symbol: stock.symbol, name: stock.name, action: 'updated' })
      } else {
        await options.deps.createPosition({
          account_id: options.accountId,
          stock_id: stock.id,
          cost_price: parsed.avgCost,
          quantity: parsed.quantity,
        })
        positions.push({
          id: -positions.length - 1,
          stock_id: stock.id,
          symbol: stock.symbol,
          market: stock.market,
        })
        succeeded.push({ symbol: stock.symbol, name: stock.name, action: 'created' })
      }
    } catch (error) {
      failed.push({
        symbol: row.symbol || '未知',
        name: row.name,
        error: error instanceof Error ? error.message : '导入失败',
      })
    }
  }

  return {
    created: succeeded.filter((item) => item.action === 'created').length,
    updated: succeeded.filter((item) => item.action === 'updated').length,
    failed,
    succeeded,
  }
}
