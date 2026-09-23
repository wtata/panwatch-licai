import { describe, expect, it } from 'vitest'
import {
  US_INTRADAY_CLOCK_KEY,
  chartTimeZone,
  formatChartClock,
  formatChartTick,
  initialIntradayClock,
  intradayClockLabel,
  readUsIntradayClock,
  writeUsIntradayClock,
} from '@panwatch/biz-ui/components/chart-time'

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

  it('美股同一时刻可按美东或北京格式化，含夏令时与冬令时', () => {
    expect(chartTimeZone('US')).toBe('America/New_York')
    // 2026-09-22 夏令时:09:30 ET = 13:30 UTC = 21:30 北京；16:00 ET = 次日 04:00 北京
    const open = Date.UTC(2026, 8, 22, 13, 30, 0) / 1000
    const close = Date.UTC(2026, 8, 22, 20, 0, 0) / 1000
    expect(formatChartClock(open, 'America/New_York')).toBe('09:30')
    expect(formatChartTick(open, 3, 'America/New_York')).toBe('09:30')
    expect(formatChartClock(open, 'Asia/Shanghai')).toBe('21:30')
    expect(formatChartTick(open, 3, 'Asia/Shanghai')).toBe('21:30')
    expect(formatChartClock(close, 'America/New_York')).toBe('16:00')
    expect(formatChartClock(close, 'Asia/Shanghai')).toBe('04:00')
    // 截图里的 00:15 是北京中午过后的钟面，对应美东 12:15，不是从 0 起算的分钟
    const afternoon = Date.UTC(2026, 8, 22, 16, 15, 0) / 1000
    expect(formatChartClock(afternoon, 'America/New_York')).toBe('12:15')
    expect(formatChartClock(afternoon, 'Asia/Shanghai')).toBe('00:15')
    // 2026-01-15 冬令时:09:30 ET = 14:30 UTC = 22:30 北京；16:00 ET = 次日 05:00 北京
    const winterOpen = Date.UTC(2026, 0, 15, 14, 30, 0) / 1000
    const winterClose = Date.UTC(2026, 0, 15, 21, 0, 0) / 1000
    expect(formatChartClock(winterOpen, 'America/New_York')).toBe('09:30')
    expect(formatChartClock(winterOpen, 'Asia/Shanghai')).toBe('22:30')
    expect(formatChartClock(winterClose, 'America/New_York')).toBe('16:00')
    expect(formatChartClock(winterClose, 'Asia/Shanghai')).toBe('05:00')
  })

  it('美股时区偏好只影响美股，A 股/港股标签不变', () => {
    localStorage.clear()
    expect(readUsIntradayClock()).toBe('America/New_York')
    expect(initialIntradayClock('US')).toBe('America/New_York')
    writeUsIntradayClock('Asia/Shanghai')
    expect(readUsIntradayClock()).toBe('Asia/Shanghai')
    expect(initialIntradayClock('us')).toBe('Asia/Shanghai')
    expect(initialIntradayClock('CN')).toBe('Asia/Shanghai')
    expect(initialIntradayClock('HK')).toBe('Asia/Shanghai')
    expect(intradayClockLabel('US', 'America/New_York')).toBe('美东时间')
    expect(intradayClockLabel('US', 'Asia/Shanghai')).toBe('北京时间')
    expect(intradayClockLabel('CN', 'Asia/Shanghai')).toBe('北京时间')
    expect(intradayClockLabel('HK', 'Asia/Shanghai')).toBe('香港时间')
    localStorage.setItem(US_INTRADAY_CLOCK_KEY, 'UTC')
    expect(readUsIntradayClock()).toBe('America/New_York')
    expect(initialIntradayClock('CN')).toBe('Asia/Shanghai')
  })
})
