/**
 * Lightweight Charts 把 Unix 秒按 UTC 画刻度。
 * A 股 09:30（北京）的绝对时间在 UTC 是 01:30，默认刻度会显示成 01:30 / 被裁成 :30。
 * 分时轴必须用市场时区格式化 tick 与十字线。
 * 美股默认美东（含夏令时），分时弹窗可改成北京时间，偏好记在 localStorage。
 */

export type ChartTime = number | string | { year: number; month: number; day: number }

export type IntradayClockZone = 'America/New_York' | 'Asia/Shanghai'

export const US_INTRADAY_CLOCK_KEY = 'panwatch.usIntradayClock'

export function chartTimeZone(market: string): string {
  const m = String(market || '').toUpperCase()
  if (m === 'US') return 'America/New_York'
  return 'Asia/Shanghai'
}

export function chartTimeZoneLabel(market: string): string {
  const m = String(market || '').toUpperCase()
  if (m === 'US') return '美东时间'
  if (m === 'HK') return '香港时间'
  return '北京时间'
}

export function intradayClockLabel(market: string, zone: string): string {
  if (String(market || '').toUpperCase() === 'US') {
    return zone === 'Asia/Shanghai' ? '北京时间' : '美东时间'
  }
  return chartTimeZoneLabel(market)
}

export function readUsIntradayClock(): IntradayClockZone {
  try {
    if (localStorage.getItem(US_INTRADAY_CLOCK_KEY) === 'Asia/Shanghai') return 'Asia/Shanghai'
  } catch {
    // 隐私模式或非浏览器环境
  }
  return 'America/New_York'
}

export function writeUsIntradayClock(zone: IntradayClockZone) {
  try {
    localStorage.setItem(US_INTRADAY_CLOCK_KEY, zone)
  } catch {
    // 写失败时仍使用当前选择，只是刷新后回到默认美东
  }
}

/** 美股读本机偏好；A 股/港股固定市场时区，不跟美股开关走。 */
export function initialIntradayClock(market: string): string {
  if (String(market || '').toUpperCase() === 'US') return readUsIntradayClock()
  return chartTimeZone(market)
}

function pad2(value: string | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '00'
  return String(Math.trunc(n)).padStart(2, '0')
}

function partsInZone(unixSeconds: number, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options }).formatToParts(
    new Date(unixSeconds * 1000),
  )
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string | undefined {
  return parts.find(item => item.type === type)?.value
}

export function toUnixSeconds(time: ChartTime): number | null {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return time > 1e12 ? Math.floor(time / 1000) : Math.floor(time)
  }
  if (typeof time === 'string') {
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return null
}

/** 十字线与分时刻度:HH:mm，固定两位，例如 09:30。 */
export function formatChartClock(time: ChartTime, timeZone: string): string {
  const sec = toUnixSeconds(time)
  if (sec == null) return ''
  const bits = partsInZone(sec, timeZone, { hour: '2-digit', minute: '2-digit' })
  return `${pad2(part(bits, 'hour'))}:${pad2(part(bits, 'minute'))}`
}

function formatChartDate(unixSeconds: number, timeZone: string): string {
  const bits = partsInZone(unixSeconds, timeZone, { month: '2-digit', day: '2-digit' })
  return `${pad2(part(bits, 'month'))}-${pad2(part(bits, 'day'))}`
}

/**
 * tickMarkType: Year=0, Month=1, DayOfMonth=2, Time=3, TimeWithSeconds=4。
 * 分时日内刻度走时钟；跨日刻度走月-日。
 */
export function formatChartTick(time: ChartTime, tickMarkType: number, timeZone: string): string {
  if (typeof time !== 'number' && typeof time !== 'string') {
    const month = pad2(String(time.month))
    const day = pad2(String(time.day))
    return `${month}-${day}`
  }
  const sec = toUnixSeconds(time)
  if (sec == null) return ''
  if (tickMarkType < 3) return formatChartDate(sec, timeZone)
  return formatChartClock(sec, timeZone)
}

export function intradayTimeScaleOptions(timeZone: string) {
  return {
    localization: {
      locale: 'zh-CN',
      timeFormatter: (time: ChartTime) => formatChartClock(time, timeZone),
    },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      fixRightEdge: true,
      rightOffset: 2,
      lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter: (time: ChartTime, tickMarkType: number) => formatChartTick(time, tickMarkType, timeZone),
    },
  }
}
