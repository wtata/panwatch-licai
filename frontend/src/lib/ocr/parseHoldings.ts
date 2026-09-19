import type { EditableHoldingRow, OcrWord, ParsedHolding } from './types'

const HEADER_RE = /证券代码|证券名称|持仓数量|可卖数量|成本价|最新市值|浮动盈亏|当日参考|市值盈亏|成本\/现价/
const SKIP_LINE_RE = /合计|可用资金|总资产|总市值|资产总值|持仓盈亏|当日盈亏|资金余额|持仓份额|参考盈亏|持仓市值|可用市值/
const CHROME_RE = /华宝证券|正在共享|持仓管理|配号买入|资产分析|Realty|Visa|Agilent|BHEM|^买入$|^卖出$|^查询$/
const NAME_TOKEN_RE = /^(?:\*?ST)?[\u4e00-\u9fa5A-Za-z0-9.*]+$/
const PERCENT_RE = /%|％/
const CN_CODE_RE = /^\d{6}$/
const HK_CODE_RE = /^\d{4,5}$/
const US_CODE_RE = /^[A-Z]{1,5}(?:\.[A-Z])?$/

const CN_PREFIX_RE = /^(00[0-3]|002|003|1[35689]|20[0-4]|30[013]|39[09]|43|50[0-9]|51[0-9]|52[0-9]|56[0-3]|58[08]|60[0135]|68[89]|83|87|88|920|9[02])/

export function toAsciiDigits(input: string): string {
  return input
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30))
    .replace(/\uFF0E/g, '.')
    .replace(/[，]/g, ',')
}

export function inferMarket(symbol: string): ParsedHolding['market'] {
  const s = symbol.trim().toUpperCase()
  if (CN_CODE_RE.test(s)) return 'CN'
  if (HK_CODE_RE.test(s)) return 'HK'
  if (US_CODE_RE.test(s)) return 'US'
  return 'CN'
}

export function normalizeSymbol(symbol: string, market: ParsedHolding['market'] = inferMarket(symbol)): string {
  const s = toAsciiDigits(symbol).trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')
  if (market === 'HK' && /^\d+$/.test(s)) return s.padStart(5, '0')
  if (market === 'CN' && /^\d+$/.test(s)) return s.padStart(6, '0')
  return s
}

function looksLikeDateCode(code: string): boolean {
  return /^20[0-3]\d(0[1-9]|1[0-2])$/.test(code)
}

function isCnSecurityCode(code: string): boolean {
  if (!CN_CODE_RE.test(code) || looksLikeDateCode(code)) return false
  return CN_PREFIX_RE.test(code)
}

function normalizeDigitish(token: string): string {
  const t = toAsciiDigits(token).trim()
  const digitish = t.replace(/[Oo]/g, '0').replace(/[Il]/g, '1')
  if (/^\d{4,6}$/.test(digitish)) return digitish
  return t.replace(/[,\s]/g, '')
}

export function parseSecurityCode(raw: string): { symbol: string; market: ParsedHolding['market'] } | null {
  const token = normalizeDigitish(raw)
  if (isCnSecurityCode(token)) return { symbol: token, market: 'CN' }
  if (HK_CODE_RE.test(token) && token.length >= 4) {
    if (token.length === 5 && !token.startsWith('0')) return null
    const symbol = token.padStart(5, '0')
    const n = Number(symbol)
    if (n >= 10000 && n % 100 === 0) return null
    if (n >= 1000 && n % 100 === 0 && (token.startsWith('0') || token.length === 4)) return null
    return { symbol, market: 'HK' }
  }
  const us = token.toUpperCase()
  // 1～2 位字母极易把界面残字、浮窗代码当成美股
  if (US_CODE_RE.test(us) && us.replace('.', '').length >= 3 && !/^(ST|ETF|H|SH|SZ)$/.test(us)) {
    return { symbol: us, market: 'US' }
  }
  return null
}

interface NumberToken {
  value: number
  raw: string
  isInt: boolean
  isPercent: boolean
}

function parseNumberToken(raw: string): NumberToken | null {
  const isPercent = PERCENT_RE.test(raw)
  let cleaned = toAsciiDigits(raw)
    .replace(/(?:HK|USD|CNY)?[￥¥$]/gi, '')
    .replace(/[,%％+\s]/g, '')
    .replace(/[Oo]/g, '0')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  const isInt = !cleaned.includes('.') && Number.isInteger(value)
  return { value: Math.abs(value), raw, isInt, isPercent }
}

function looksLikeMarketValue(value: number, quantity: number | null): boolean {
  if (quantity == null) return value >= 10000 && Number.isInteger(value)
  return value >= 10000 && value > quantity * 20
}

function looksLikePrice(token: NumberToken): boolean {
  return token.value >= 0.01 && token.value <= 100000 && (!token.isInt || token.value < 20000)
}

function looksLikeQty(token: NumberToken): boolean {
  return token.isInt && token.value >= 1 && token.value <= 1e8
}

function isPnlToken(token: NumberToken): boolean {
  if (token.isPercent) return true
  return /^[+\-]/.test(token.raw.trim())
}

function pickQtyAndCost(
  numbers: NumberToken[],
  market: ParsedHolding['market'],
): { quantity: number | null; avgCost: number | null; warnings: string[] } {
  const warnings: string[] = []
  // 同花顺 App：名称 | 盈亏(忽略) | 持仓/可用(取上) | 成本/现价(取上)
  // 桌面表：持仓数量、可卖数量、成本价、现价、市值、盈亏
  const useful = numbers.filter((n) => !isPnlToken(n) && n.value > 0)
  if (useful.length === 0) {
    return { quantity: null, avgCost: null, warnings: ['未识别到数量和成本'] }
  }

  let start = 0
  while (start < useful.length && !looksLikeQty(useful[start])) start += 1
  const rest = useful.slice(start)

  let quantity: number | null = rest[0] && looksLikeQty(rest[0]) ? rest[0].value : null
  let afterQty = rest.slice(1)
  if (quantity != null && afterQty[0] && looksLikeQty(afterQty[0])) {
    afterQty = afterQty.slice(1)
  }

  const costCandidates = afterQty.filter((n) => {
    if (looksLikeMarketValue(n.value, quantity)) return false
    return looksLikePrice(n)
  })
  const withDecimal = costCandidates.find((n) => !n.isInt || n.raw.includes('.'))
  const avgCost = (withDecimal || costCandidates[0] || null)?.value ?? null

  if (quantity == null) warnings.push('未识别到持仓数量')
  if (avgCost == null) warnings.push('未识别到成本价')
  if (quantity != null && market === 'CN' && quantity % 100 !== 0) {
    warnings.push('A 股数量通常为 100 的整数倍，请核对')
  }
  if (avgCost != null && avgCost >= 50000) {
    warnings.push('成本价异常偏高，请核对')
  }
  return { quantity, avgCost, warnings }
}

type ColumnKey = 'code' | 'name' | 'qty' | 'sellable' | 'cost' | 'price' | 'mv' | 'pnl'

interface HeaderCol {
  key: ColumnKey
  x: number
}

function classifyHeaderToken(text: string): ColumnKey | null {
  const t = toAsciiDigits(text).replace(/\s+/g, '')
  if (/可卖/.test(t)) return 'sellable'
  if (/证券代码|^代码$/.test(t)) return 'code'
  if (/证券名称|^名称$/.test(t)) return 'name'
  if (/持仓数量|持股数量|持仓股数|^持股$|^持仓$/.test(t)) return 'qty'
  if (/成本/.test(t)) return 'cost'
  if (/现价|最新价|当前价/.test(t)) return 'price'
  if (/市值/.test(t)) return 'mv'
  if (/盈亏/.test(t)) return 'pnl'
  return null
}

export function detectHeaderColumns(rows: OcrWord[][]): HeaderCol[] | null {
  for (const row of rows.slice(0, 8)) {
    const cols: HeaderCol[] = []
    for (const word of row) {
      const key = classifyHeaderToken(word.text)
      if (!key) continue
      cols.push({ key, x: (word.bbox.x0 + word.bbox.x1) / 2 })
    }
    const keys = new Set(cols.map((col) => col.key))
    if (keys.has('qty') && (keys.has('cost') || keys.has('price') || keys.has('name') || keys.has('code'))) {
      return cols.sort((a, b) => a.x - b.x)
    }
    if (keys.has('code') && (keys.has('qty') || keys.has('cost') || keys.has('name'))) {
      return cols.sort((a, b) => a.x - b.x)
    }
  }
  return null
}

function assignWordsToColumns(row: OcrWord[], headers: HeaderCol[]): Record<ColumnKey, string[]> {
  const buckets = {
    code: [],
    name: [],
    qty: [],
    sellable: [],
    cost: [],
    price: [],
    mv: [],
    pnl: [],
  } as Record<ColumnKey, string[]>
  for (const word of row) {
    const cx = (word.bbox.x0 + word.bbox.x1) / 2
    let best = headers[0]
    let bestDist = Number.POSITIVE_INFINITY
    for (const col of headers) {
      const dist = Math.abs(cx - col.x)
      if (dist < bestDist) {
        best = col
        bestDist = dist
      }
    }
    if (!best) continue
    buckets[best.key].push(word.text)
  }
  return buckets
}

function firstNumber(tokens: string[]): number | null {
  for (const token of tokens) {
    const parsed = parseNumberToken(token)
    if (parsed && !parsed.isPercent && parsed.value > 0) return parsed.value
  }
  return null
}

function holdingFromColumns(
  buckets: Record<ColumnKey, string[]>,
  sourceConfidence?: number,
): ParsedHolding | null {
  const codeTokens = [...buckets.code, ...buckets.name]
  let parsedCode: { symbol: string; market: ParsedHolding['market'] } | null = null
  for (const token of codeTokens) {
    parsedCode = parseSecurityCode(token)
    if (parsedCode) break
  }
  if (!parsedCode) {
    const compact = codeTokens.join('').match(/(\d{6})/)
    if (compact) parsedCode = parseSecurityCode(compact[1])
  }
  const name = extractName(buckets.name.length ? buckets.name : buckets.code.filter((token) => !parseSecurityCode(token)))
    .replace(/\d+(?:\.\d+)?$/, '')
  if (!parsedCode && !isChineseStockName(name)) return null

  const quantity = firstNumber(buckets.qty) ?? firstNumber(buckets.sellable)
  const avgCost = firstNumber(buckets.cost) ?? (buckets.cost.length ? null : firstNumber(buckets.price))
  if (quantity != null && quantity <= 0) return null
  const warnings: string[] = []
  if (!name) warnings.push('未识别到股票名称')
  if (!parsedCode) warnings.push('未识别到证券代码，将按名称匹配')
  if (quantity == null) warnings.push('未识别到持仓数量')
  else if (firstNumber(buckets.qty) == null && firstNumber(buckets.sellable) != null) {
    warnings.push('未读到持仓数量，已用可卖数量代替')
  }
  if (avgCost == null) warnings.push('未识别到成本价')
  const market = parsedCode?.market ?? 'CN'
  if (quantity != null && market === 'CN' && quantity % 100 !== 0) {
    warnings.push('A 股数量通常为 100 的整数倍，请核对')
  }
  if (sourceConfidence != null && sourceConfidence < 60) warnings.push('该行识别置信度偏低')
  return {
    symbol: parsedCode?.symbol ?? '',
    name,
    market,
    quantity,
    avgCost,
    warnings: Array.from(new Set(warnings)),
  }
}

function isSummaryLine(text: string): boolean {
  if (SKIP_LINE_RE.test(text) || CHROME_RE.test(text) || /正在共享/.test(text)) return true
  if (/持仓/.test(text) && /可用/.test(text)) return true
  if (/^(持仓|可用|市值|盈亏|成本\/现价)$/.test(text.trim())) return true
  if (/[\u4e00-\u9fa5]{2,}/.test(text) || /\d{6}/.test(text)) return false
  const amounts = text.match(/\d[\d,]*(?:\.\d+)?/g) || []
  const large = amounts.map((item) => Number(item.replace(/,/g, ''))).filter((value) => Number.isFinite(value) && value >= 1000)
  return large.length >= 3
}

export function cleanStockName(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[-–—]?\d+(?:\.\d+)?$/, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9.*]/g, '')
}

const GENERIC_NAME_RE = /^(股份|科技|技术|集团|国际|软件|数据|控股|发展|投资|资源|材料|电气|通信|制药|生物|医疗|有限|公司)$/

function isChineseStockName(text: string): boolean {
  const t = cleanStockName(text)
  if (t.length < 2 || t.length > 10) return false
  if (!/[\u4e00-\u9fa5]{2,}/.test(t)) return false
  if (GENERIC_NAME_RE.test(t)) return false
  if (HEADER_RE.test(t) || SKIP_LINE_RE.test(t) || CHROME_RE.test(t)) return false
  if (/持仓|盈亏|成本|现价|市值|可卖|合计|可用|证券/.test(t)) return false
  return true
}

export function nameAppearsInOcrText(name: string, ocrText: string): boolean {
  const n = cleanStockName(name)
  if (!n) return false
  const compact = (ocrText || '').replace(/\s+/g, '')
  return compact.includes(n)
}

export function filterHoldingsByOcrText(rows: ParsedHolding[], ocrText: string): ParsedHolding[] {
  const compact = (ocrText || '').replace(/\s+/g, '')
  if (compact.length < 8) return rows
  return rows.filter((row) => nameAppearsInOcrText(row.name, ocrText))
}

export function namesCompatible(ocrName: string, officialName: string): boolean {
  const a = cleanStockName(ocrName)
  const b = cleanStockName(officialName)
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 3 && (b.includes(a) || a.includes(b))) return true
  if (b.length >= 3 && (a.includes(b) || b.includes(a))) return true
  return false
}

function parseMobileNameRow(tokens: string[], sourceConfidence?: number): ParsedHolding | null {
  const cleaned = tokens
    .flatMap(splitLineTokens)
    .map((token) => token.replace(/^HK\$/i, ''))
    .filter((token) => token && !/^HK\$?$/i.test(token))
  if (cleaned.length === 0) return null
  const joined = cleaned.join(' ')
  if (isSummaryLine(joined) || isHeaderLine(joined)) return null
  if (parseSecurityCode(cleaned[0])) return null

  let start = 0
  while (start < cleaned.length && !isChineseStockName(cleaned[start])) start += 1

  let name = cleanStockName(cleaned[start] || '')
  if (!isChineseStockName(name)) return null
  let consumed = 1
  while (start + consumed < cleaned.length) {
    const nxtRaw = cleaned[start + consumed]
    if (parseNumberToken(nxtRaw) && !/[\u4e00-\u9fa5]/.test(nxtRaw)) break
    const nxt = cleanStockName(nxtRaw)
    if (!/[\u4e00-\u9fa5]{1,4}/.test(nxt)) break
    const joined = name + nxt
    const suffix = GENERIC_NAME_RE.test(nxt) || nxt.length <= 2
    if (!suffix && nxt.length >= 3 && isChineseStockName(nxt)) break
    if (joined.length > 8) break
    name = joined
    consumed += 1
  }
  if (!isChineseStockName(name)) return null

  const rest = cleaned.slice(start + consumed)
  const numberTokens = rest
    .flatMap((token) => token.split(/(?=[+\-])|(?<=%)/))
    .map(parseNumberToken)
    .filter((n): n is NumberToken => n != null)

  const { quantity, avgCost, warnings } = pickQtyAndCost(numberTokens, 'CN')
  if (quantity == null || quantity <= 0 || avgCost == null) return null

  const allWarnings = [...warnings, '未识别到证券代码，将按名称匹配']
  if (sourceConfidence != null && sourceConfidence < 60) allWarnings.push('该行识别置信度偏低')
  return {
    symbol: '',
    name,
    market: /HK\$/i.test(tokens.join(' ')) ? 'HK' : 'CN',
    quantity,
    avgCost,
    warnings: Array.from(new Set(allWarnings)),
  }
}

function extractName(tokens: string[]): string {
  const parts: string[] = []
  for (const token of tokens) {
    const t = token.trim()
    if (!t) continue
    if (parseSecurityCode(t)) break
    if (parseNumberToken(t) && !/[\u4e00-\u9fa5]/.test(t)) break
    if (/^(持仓数量|可卖数量|成本价|持仓|成本|现价|市值|盈亏|可卖)$/.test(t)) continue
    if (!NAME_TOKEN_RE.test(t) && !/[\u4e00-\u9fa5]/.test(t)) continue
    if (HEADER_RE.test(t) || SKIP_LINE_RE.test(t)) continue
    parts.push(t.replace(/^[.]+/, ''))
  }
  return parts.join('').replace(/\s+/g, '')
}

function splitLineTokens(line: string): string[] {
  return toAsciiDigits(line)
    .replace(/([\u4e00-\u9fa5])(\d)/g, '$1 $2')
    .replace(/(\d)([\u4e00-\u9fa5])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
}

function isHeaderLine(text: string): boolean {
  const hits = text.match(/证券代码|证券名称|持仓数量|可卖数量|最新市值|浮动盈亏|当日参考/g)
  return (hits?.length ?? 0) >= 2 || (/证券代码/.test(text) && /持仓/.test(text))
}

function isStackedContinuationLine(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[\u4e00-\u9fa5]{2,}/.test(t)) return false
  const first = t.split(/\s+/)[0] || ''
  if (parseSecurityCode(first) || /^\d{6}$/.test(t.replace(/\s/g, ''))) return false
  return /^[\d.+\-%％HK$￥¥,\s]+$/i.test(t)
}

function parseRowTokens(tokens: string[], sourceConfidence?: number): ParsedHolding | null {
  const cleaned = tokens.flatMap(splitLineTokens)
  if (cleaned.length === 0) return null
  const joined = cleaned.join(' ')
  if (isSummaryLine(joined)) return null

  let codeIndex = -1
  let parsedCode: { symbol: string; market: ParsedHolding['market'] } | null = null
  for (let i = 0; i < cleaned.length; i++) {
    const code = parseSecurityCode(cleaned[i])
    if (code) {
      codeIndex = i
      parsedCode = code
      break
    }
  }
  if (!parsedCode) {
    const joined = cleaned.join('')
    const compact = joined.match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/)
    if (compact) parsedCode = parseSecurityCode(compact[1])
    if (!parsedCode) return null
    if (isHeaderLine(joined)) return null
    codeIndex = 0
  }

  const after = cleaned.slice(codeIndex + 1)
  const name = extractName(after) || ''
  const numberTokens = after
    .flatMap((token) => token.split(/(?=[+\-])|(?<=%)/))
    .map(parseNumberToken)
    .filter((n): n is NumberToken => n != null)

  const { quantity, avgCost, warnings } = pickQtyAndCost(numberTokens, parsedCode.market)
  const allWarnings = [...warnings]
  if (!name) allWarnings.push('未识别到股票名称')
  if (sourceConfidence != null && sourceConfidence < 60) allWarnings.push('该行识别置信度偏低')

  return {
    symbol: parsedCode.symbol,
    name,
    market: parsedCode.market,
    quantity,
    avgCost,
    warnings: Array.from(new Set(allWarnings)),
  }
}

function mergeDigitFragments(words: OcrWord[]): OcrWord[] {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  const merged: OcrWord[] = []
  for (const word of sorted) {
    const prev = merged[merged.length - 1]
    if (!prev) {
      merged.push({ ...word })
      continue
    }
    const prevText = normalizeDigitish(prev.text)
    const curText = normalizeDigitish(word.text)
    const closeX = word.bbox.x0 - prev.bbox.x1 < Math.max(12, (prev.bbox.x1 - prev.bbox.x0) * 0.6)
    const closeY = Math.abs(((word.bbox.y0 + word.bbox.y1) / 2) - ((prev.bbox.y0 + prev.bbox.y1) / 2)) < 10
    if (closeX && closeY && /^\d+$/.test(prevText) && /^\d+$/.test(curText)) {
      const combined = prevText + curText
      if (combined.length === 6) {
        prev.text = combined
        prev.bbox = { ...prev.bbox, x1: Math.max(prev.bbox.x1, word.bbox.x1) }
        prev.confidence = Math.min(prev.confidence, word.confidence)
        continue
      }
    }
    merged.push({ ...word })
  }
  return merged
}

export function groupWordsIntoRows(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  if (sorted.length === 0) return []
  const heights = sorted.map((w) => Math.max(8, w.bbox.y1 - w.bbox.y0)).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 16
  const thresh = Math.max(10, medianH * 0.65)

  const rows: OcrWord[][] = []
  for (const word of sorted) {
    const cy = (word.bbox.y0 + word.bbox.y1) / 2
    const last = rows[rows.length - 1]
    if (!last) {
      rows.push([word])
      continue
    }
    const lastCy = last.reduce((sum, w) => sum + (w.bbox.y0 + w.bbox.y1) / 2, 0) / last.length
    if (Math.abs(cy - lastCy) <= thresh) last.push(word)
    else rows.push([word])
  }
  return rows.map((row) => [...row].sort((a, b) => a.bbox.x0 - b.bbox.x0))
}

export function parseHoldingsFromWords(words: OcrWord[]): ParsedHolding[] {
  const rows = groupWordsIntoRows(mergeDigitFragments(words.filter((w) => w.text.trim())))
  const headers = detectHeaderColumns(rows)
  const holdings: ParsedHolding[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const joined = row.map((word) => word.text).join(' ')
    if (isHeaderLine(joined) || isSummaryLine(joined)) continue
    const next = rows[i + 1]
    const nextJoined = next?.map((word) => word.text).join(' ') || ''
    const tokens = [...row.map((word) => word.text)]
    if (next && isStackedContinuationLine(nextJoined)) {
      tokens.push(...next.map((word) => word.text))
      i += 1
    }
    const confidenceSum = row.reduce((sum, word) => sum + word.confidence, 0)
    const confidence = row.length ? confidenceSum / row.length : undefined
    const fromColumns = headers ? holdingFromColumns(assignWordsToColumns(row, headers), confidence) : null
    const fromMobile = parseMobileNameRow(tokens, confidence)
    const fromTokens = parseRowTokens(tokens, confidence)
    const parsed = pickBestRowParse(fromMobile, fromColumns, fromTokens)
    if (parsed) holdings.push(parsed)
  }
  return uniqueHoldings(holdings)
}

export function parseHoldingsFromText(text: string): ParsedHolding[] {
  const lines = toAsciiDigits(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const holdings: ParsedHolding[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isHeaderLine(line) || isSummaryLine(line)) continue
    if (/,/.test(line) && /^[\d,.\s]+$/.test(line)) continue

    let lineTokens = line.split(/\s+/)
    if (
      /^[\u4e00-\u9fa5.*]{2,8}$/.test(line)
      && i + 1 < lines.length
      && /[\d.%％]/.test(lines[i + 1])
      && !/^[\u4e00-\u9fa5.*]{2,8}$/.test(lines[i + 1].split(/\s+/)[0] || '')
    ) {
      lineTokens = [line, ...lines[i + 1].split(/\s+/)]
    }
    if (i + 1 < lines.length && isStackedContinuationLine(lines[i + 1])) {
      lineTokens = [...lineTokens, ...lines[i + 1].split(/\s+/)]
      i += 1
    }

    const mobile = parseMobileNameRow(lineTokens)
    if (mobile) {
      holdings.push(mobile)
      continue
    }

    const direct = parseRowTokens(lineTokens)
    if (direct && direct.quantity != null && direct.avgCost != null && (direct.name || direct.symbol)) {
      if (!direct.name && i > 0 && /[\u4e00-\u9fa5]/.test(lines[i - 1]) && !parseSecurityCode(lines[i - 1])) {
        direct.name = lines[i - 1].replace(/\s+/g, '')
        direct.warnings = direct.warnings.filter((w) => w !== '未识别到股票名称')
      }
      holdings.push(direct)
      continue
    }

    const codeOnly = parseSecurityCode(line.replace(/\s+/g, ''))
    if (!codeOnly) continue
    const nearby: string[] = []
    if (i > 0 && isChineseStockName(lines[i - 1])) nearby.push(lines[i - 1])
    nearby.push(line)
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const first = lines[j].split(/\s+/)[0] || ''
      if (parseSecurityCode(first)) break
      if (isChineseStockName(first) && !/持仓|成本/.test(lines[j])) break
      nearby.push(lines[j])
    }
    const parsed = parseRowTokens([codeOnly.symbol, ...nearby.join(' ').split(/\s+/).filter((t) => t !== line)])
    if (parsed) holdings.push(parsed)
  }
  return uniqueHoldings(holdings)
}

function pickBestRowParse(
  mobile: ParsedHolding | null,
  primary: ParsedHolding | null,
  fallback: ParsedHolding | null,
): ParsedHolding | null {
  const mobileComplete = mobile != null && mobile.quantity != null && mobile.avgCost != null && isChineseStockName(mobile.name)
  const primaryUsJunk = primary != null && primary.market === 'US' && primary.symbol.length <= 4 && !isChineseStockName(primary.name)
  if (mobileComplete && (!primary || primaryUsJunk || !primary.quantity || !primary.avgCost)) {
    return mergeRowParse(mobile, primary || fallback)
  }
  return mergeRowParse(primary, fallback) || mobile
}

function preferCost(primary: number | null, fallback: number | null): number | null {
  if (primary == null) return fallback
  if (fallback == null) return primary
  const primaryLooksQty = Number.isInteger(primary) && primary >= 10
  const fallbackLooksPrice = !Number.isInteger(fallback)
  if (primaryLooksQty && fallbackLooksPrice) return fallback
  return primary
}

function mergeRowParse(primary: ParsedHolding | null, fallback: ParsedHolding | null): ParsedHolding | null {
  if (!primary) return fallback
  if (!fallback) return primary
  const merged: ParsedHolding = {
    symbol: primary.symbol,
    name: primary.name || fallback.name,
    market: primary.market,
    quantity: primary.quantity ?? fallback.quantity,
    avgCost: preferCost(primary.avgCost, fallback.avgCost),
    warnings: [],
  }
  const warnings = new Set<string>()
  if (!merged.name) warnings.add('未识别到股票名称')
  if (merged.quantity == null) warnings.add('未识别到持仓数量')
  if (merged.avgCost == null) warnings.add('未识别到成本价')
  for (const warning of [...primary.warnings, ...fallback.warnings]) {
    if (warning === '未识别到股票名称' && merged.name) continue
    if (warning === '未识别到持仓数量' && merged.quantity != null) continue
    if (warning === '未识别到成本价' && merged.avgCost != null) continue
    if (warning.startsWith('未读到持仓数量') && primary.quantity != null) continue
    warnings.add(warning)
  }
  merged.warnings = Array.from(warnings)
  return merged
}

function completeness(row: ParsedHolding): number {
  return (row.quantity != null ? 2 : 0) + (row.avgCost != null ? 2 : 0) + (row.name ? 1 : 0) - row.warnings.length * 0.1
}

function uniqueByCleanName(rows: ParsedHolding[]): ParsedHolding[] {
  const byName = new Map<string, ParsedHolding>()
  const order: string[] = []
  for (const row of rows) {
    const key = cleanStockName(row.name)
    const prev = byName.get(key)
    if (!prev) {
      order.push(key)
      byName.set(key, row)
      continue
    }
    const betterSymbol = Boolean(row.symbol && !prev.symbol)
    if (betterSymbol || completeness(row) > completeness(prev)) byName.set(key, row)
  }
  return order.map((key) => byName.get(key)!)
}

function uniqueHoldings(rows: ParsedHolding[]): ParsedHolding[] {
  const byKey = new Map<string, ParsedHolding>()
  for (const row of rows) {
    const key = row.symbol ? `${row.market}:${row.symbol}` : `NAME:${row.name}`
    const prev = byKey.get(key)
    if (!prev || completeness(row) > completeness(prev)) byKey.set(key, row)
  }
  return uniqueByCleanName(dedupeByQtyCost(Array.from(byKey.values())))
}

function qtyCostKey(row: ParsedHolding): string | null {
  if (row.quantity == null || row.avgCost == null) return null
  return `${row.quantity}:${row.avgCost.toFixed(2)}`
}

function dedupeByQtyCost(rows: ParsedHolding[]): ParsedHolding[] {
  const best = new Map<string, ParsedHolding>()
  const order: string[] = []
  let extra = 0
  for (const row of rows) {
    const key = qtyCostKey(row) || `__${extra++}`
    const prev = best.get(key)
    if (!prev) {
      order.push(key)
      best.set(key, row)
      continue
    }
    const longerName = cleanStockName(row.name).length > cleanStockName(prev.name).length
    if (completeness(row) > completeness(prev) || (longerName && completeness(row) >= completeness(prev) - 0.2)) {
      best.set(key, row)
    }
  }
  return order.map((key) => best.get(key)!)
}

export function mergeParsedHoldings(primary: ParsedHolding[], secondary: ParsedHolding[]): ParsedHolding[] {
  const byKey = new Map<string, ParsedHolding>()
  for (const row of [...primary, ...secondary]) {
    const key = row.symbol ? `${row.market}:${row.symbol}` : `NAME:${row.name}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, { ...row, warnings: [...row.warnings] })
      continue
    }
    const merged: ParsedHolding = {
      symbol: prev.symbol,
      name: prev.name || row.name,
      market: prev.market,
      quantity: prev.quantity ?? row.quantity,
      avgCost: prev.avgCost ?? row.avgCost,
      warnings: [],
    }
    const warnings = new Set<string>()
    if (!merged.name) warnings.add('未识别到股票名称')
    if (merged.quantity == null) warnings.add('未识别到持仓数量')
    if (merged.avgCost == null) warnings.add('未识别到成本价')
    for (const w of [...prev.warnings, ...row.warnings]) {
      if (w === '未识别到股票名称' && merged.name) continue
      if (w === '未识别到持仓数量' && merged.quantity != null) continue
      if (w === '未识别到成本价' && merged.avgCost != null) continue
      if (w === '未识别到数量和成本' && merged.quantity != null && merged.avgCost != null) continue
      warnings.add(w)
    }
    merged.warnings = Array.from(warnings)
    byKey.set(key, merged)
  }
  const primaryOrder = primary.map((r) => `${r.market}:${r.symbol}`)
  const keys = Array.from(byKey.keys())
  keys.sort((a, b) => {
    const ia = primaryOrder.indexOf(a)
    const ib = primaryOrder.indexOf(b)
    if (ia === -1 && ib === -1) return 0
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  return keys.map((k) => byKey.get(k)!)
}

export function isPlausibleHolding(row: ParsedHolding): boolean {
  if (!isChineseStockName(row.name)) return false
  if ((row.market || 'CN') === 'CN' && cleanStockName(row.name).length < 3) return false
  if (row.quantity == null || row.quantity <= 0 || row.avgCost == null || row.avgCost <= 0) return false
  if (row.market === 'CN' && (!Number.isInteger(row.quantity) || row.quantity % 100 !== 0)) return false
  if (row.symbol) {
    const n = Number(row.symbol)
    if (row.market === 'HK' && Number.isFinite(n) && n >= 1000 && n % 100 === 0) return false
    if (row.market === 'US' && !isChineseStockName(row.name) && row.symbol.length < 4) return false
  }
  return true
}

function dropNameFragments(rows: ParsedHolding[]): ParsedHolding[] {
  return rows.filter((row) => {
    const name = cleanStockName(row.name)
    if (GENERIC_NAME_RE.test(name)) return false
    return !rows.some((other) => {
      const otherName = cleanStockName(other.name)
      return otherName !== name && otherName.includes(name) && name.length <= 3 && otherName.length > name.length
    })
  })
}

export function sanitizeHoldings(rows: ParsedHolding[]): ParsedHolding[] {
  return uniqueHoldings(dropNameFragments(rows.filter(isPlausibleHolding).map((row) => ({
    ...row,
    name: cleanStockName(row.name),
  }))))
}

export function preferOcrHoldings(
  ocr: ParsedHolding[],
  vision: ParsedHolding[],
  ocrText = '',
): ParsedHolding[] {
  const fromOcr = sanitizeHoldings(ocr)
  const fromVision = sanitizeHoldings(vision)
  const fillCodes = (rows: ParsedHolding[]) =>
    uniqueHoldings(rows.map((row) => {
      const hit = fromVision.find((item) => namesCompatible(item.name, row.name))
      if (!hit?.symbol || row.symbol) return row
      return {
        ...row,
        symbol: hit.symbol,
        market: hit.market,
        warnings: row.warnings.filter((item) => !item.includes('证券代码')),
      }
    }))
  if (fromOcr.length > 0) return fillCodes(fromOcr)
  return fillCodes(filterHoldingsByOcrText(fromVision, ocrText))
}

export function holdingsFromVisionItems(items: Array<Record<string, unknown>>): ParsedHolding[] {
  const holdings: ParsedHolding[] = []
  for (const item of items) {
    const rawCode = String(item.code ?? item.symbol ?? '').trim()
    const name = cleanStockName(String(item.name ?? '').trim())
    if (CHROME_RE.test(rawCode) || CHROME_RE.test(name) || /正在共享|可用成本/.test(name)) continue
    const parsedCode = parseSecurityCode(rawCode)
    if (!parsedCode && !isChineseStockName(name)) continue
    const marketRaw = String(item.market ?? parsedCode?.market ?? 'CN').toUpperCase()
    const market: ParsedHolding['market'] =
      marketRaw === 'HK' || marketRaw === 'US' ? marketRaw : parsedCode?.market ?? 'CN'
    const quantity = Number(item.quantity)
    const avgCost = Number(item.avgCost ?? item.costPrice ?? item.cost_price)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    if (!Number.isFinite(avgCost) || avgCost <= 0) continue
    const warnings: string[] = []
    if (!parsedCode) warnings.push('未识别到证券代码，将按名称匹配')
    if (!name) warnings.push('未识别到股票名称')
    holdings.push({
      symbol: parsedCode ? normalizeSymbol(parsedCode.symbol, market) : '',
      name,
      market,
      quantity,
      avgCost,
      warnings,
    })
  }
  return sanitizeHoldings(holdings)
}

export function isReliableVisionHoldings(rows: ParsedHolding[]): boolean {
  return sanitizeHoldings(rows).length > 0
}

export function parseHoldings(input: { text: string; words?: OcrWord[] }): ParsedHolding[] {
  const fromWords = input.words?.length ? parseHoldingsFromWords(input.words) : []
  const fromText = parseHoldingsFromText(input.text || '')
  return sanitizeHoldings(mergeParsedHoldings(fromWords, fromText))
}

export function toEditableRows(holdings: ParsedHolding[]): EditableHoldingRow[] {
  return holdings.map((row, index) => ({
    id: `${row.market}-${row.symbol}-${index}`,
    selected: Boolean(row.quantity && row.avgCost && row.name && (row.symbol || isChineseStockName(row.name))),
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    quantity: row.quantity != null ? String(row.quantity) : '',
    avgCost: row.avgCost != null ? String(Number(row.avgCost.toFixed(4))) : '',
    warnings: row.warnings,
  }))
}
