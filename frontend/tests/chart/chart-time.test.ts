import { describe, expect, it } from 'vitest'
import { chartTimeZone, formatChartClock, formatChartTick } from '@panwatch/biz-ui/components/chart-time'

describe('分时轴时区', () => {
  const shanghai = (hour: number, minute: number) => Date.UTC(2026, 8, 22, hour - 8, minute, 0) / 1000

  it('CN/HK 使用上海时区，A 股 09:30 不显示成 UTC 01:30', () => {
    expect(chartTimeZone('CN')).toBe('Asia/Shanghai')
    expect(chartTimeZone('HK')).toBe('Asia/Shanghai')
    const ts = shanghai(9, 30)
    expect(formatChartClock(ts, 'UTC')).toBe('01:30')
    expect(formatChartClock(ts, chartTimeZone('CN'))).toBe('09:30')
    expect(formatChartTick(ts, 3, 'Asia/Shanghai')).toBe('09:30')
    expect(formatChartClock(shanghai(10, 0), 'Asia/Shanghai')).toBe('10:00')
    expect(formatChartClock(shanghai(11, 30), 'Asia/Shanghai')).toBe('11:30')
    expect(formatChartClock(shanghai(13, 0), 'Asia/Shanghai')).toBe('13:00')
    expect(formatChartClock(shanghai(15, 0), 'Asia/Shanghai')).toBe('15:00')
  })

  it('美股刻度用美东时间', () => {
    expect(chartTimeZone('US')).toBe('America/New_York')
    const ts = Date.UTC(2026, 8, 22, 13, 30, 0) / 1000
    expect(formatChartClock(ts, 'America/New_York')).toBe('09:30')
  })
})
