import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TimeshareChart from '@panwatch/biz-ui/components/TimeshareChart'

const ts0930 = Date.UTC(2026, 8, 22, 1, 30, 0) / 1000
const ts1500 = Date.UTC(2026, 8, 22, 7, 0, 0) / 1000

vi.mock('@panwatch/api', () => ({
  fetchAPI: vi.fn(async () => ({
    timezone: 'Asia/Shanghai',
    prev_close: 10,
    points: [
      { time: '2026-09-22 09:30', ts: ts0930, price: 10.2, avg: 10.1, volume: 100 },
      { time: '2026-09-22 15:00', ts: ts1500, price: 10.4, avg: 10.2, volume: 60 },
    ],
  })),
}))

describe('TimeshareChart 刻度', () => {
  beforeEach(() => {
    if (!('ResizeObserver' in window)) {
      class RO {
        observe() {}
        disconnect() {}
      }
      ;(window as any).ResizeObserver = RO
    }
  })

  it('把 A 股 Unix 时间格式化成北京时间 09:30，而不是 UTC 01:30', async () => {
    let options: any = null
    const series = () => ({ setData: vi.fn(), createPriceLine: vi.fn() })
    ;(window as any).LightweightCharts = {
      createChart: vi.fn((_: unknown, opts: unknown) => {
        options = opts
        return {
          addLineSeries: series,
          addHistogramSeries: series,
          priceScale: () => ({ applyOptions: vi.fn() }),
          timeScale: () => ({ setVisibleLogicalRange: vi.fn() }),
          subscribeCrosshairMove: vi.fn(),
          applyOptions: vi.fn(),
          remove: vi.fn(),
        }
      }),
    }

    render(<TimeshareChart symbol="300409" market="CN" />)

    await waitFor(() => {
      expect(options).toBeTruthy()
    })

    expect(options.timeScale.tickMarkFormatter(ts0930, 3)).toBe('09:30')
    expect(options.timeScale.tickMarkFormatter(ts1500, 3)).toBe('15:00')
    expect(options.localization.timeFormatter(ts0930)).toBe('09:30')
    expect(options.localization.timeFormatter(ts0930)).not.toBe('01:30')
  })
})
