import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { US_INTRADAY_CLOCK_KEY } from '@panwatch/biz-ui/components/chart-time'
import TimeshareChart from '@panwatch/biz-ui/components/TimeshareChart'

const ts0930 = Date.UTC(2026, 8, 22, 1, 30, 0) / 1000
const ts1500 = Date.UTC(2026, 8, 22, 7, 0, 0) / 1000
const usOpen = Date.UTC(2026, 8, 22, 13, 30, 0) / 1000
const usClose = Date.UTC(2026, 8, 22, 20, 0, 0) / 1000

const cnPayload = {
  timezone: 'Asia/Shanghai',
  prev_close: 10,
  points: [
    { time: '2026-09-22 09:30', ts: ts0930, price: 10.2, avg: 10.1, volume: 100 },
    { time: '2026-09-22 15:00', ts: ts1500, price: 10.4, avg: 10.2, volume: 60 },
  ],
}

const usPayload = {
  timezone: 'America/New_York',
  prev_close: 100,
  points: [
    { time: '2026-09-22 09:30', ts: usOpen, price: 101, avg: 100.5, volume: 10 },
    { time: '2026-09-22 16:00', ts: usClose, price: 102, avg: 101, volume: 12 },
  ],
}

vi.mock('@panwatch/api', () => ({
  fetchAPI: vi.fn(),
}))

const fetchMock = fetchAPI as unknown as ReturnType<typeof vi.fn>

function installChart() {
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
  return {
    get options() {
      return options
    },
  }
}

describe('TimeshareChart 刻度', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(cnPayload)
    if (!('ResizeObserver' in window)) {
      class RO {
        observe() {}
        disconnect() {}
      }
      ;(window as any).ResizeObserver = RO
    }
  })

  it('把 A 股 Unix 时间格式化成北京时间 09:30，而不是 UTC 01:30', async () => {
    const chart = installChart()
    render(<TimeshareChart symbol="300409" market="CN" />)

    await waitFor(() => {
      expect(chart.options).toBeTruthy()
    })

    expect(screen.queryByRole('button', { name: '美东' })).toBeNull()
    expect(chart.options.timeScale.tickMarkFormatter(ts0930, 3)).toBe('09:30')
    expect(chart.options.timeScale.tickMarkFormatter(ts1500, 3)).toBe('15:00')
    expect(chart.options.localization.timeFormatter(ts0930)).toBe('09:30')
    expect(chart.options.localization.timeFormatter(ts0930)).not.toBe('01:30')
  })

  it('美股默认美东 09:30/16:00，切换北京后十字线与刻度一起变成 21:30/04:00', async () => {
    fetchMock.mockResolvedValue(usPayload)
    const chart = installChart()
    const view = render(<TimeshareChart symbol="MRVL" market="US" />)

    await waitFor(() => {
      expect(chart.options?.timeScale.tickMarkFormatter(usOpen, 3)).toBe('09:30')
    })
    expect(chart.options.timeScale.tickMarkFormatter(usClose, 3)).toBe('16:00')
    expect(chart.options.localization.timeFormatter(usOpen)).toBe('09:30')
    expect(chart.options.localization.timeFormatter(usClose)).toBe('16:00')
    expect(screen.getByText('美东时间')).toBeTruthy()
    expect(screen.getByRole('button', { name: '美东' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '北京' }))

    await waitFor(() => {
      expect(chart.options.timeScale.tickMarkFormatter(usOpen, 3)).toBe('21:30')
    })
    expect(chart.options.timeScale.tickMarkFormatter(usClose, 3)).toBe('04:00')
    expect(chart.options.localization.timeFormatter(usOpen)).toBe('21:30')
    expect(chart.options.localization.timeFormatter(usClose)).toBe('04:00')
    expect(screen.getByText('北京时间')).toBeTruthy()
    expect(localStorage.getItem(US_INTRADAY_CLOCK_KEY)).toBe('Asia/Shanghai')

    view.unmount()
    const again = installChart()
    render(<TimeshareChart symbol="MRVL" market="US" />)
    await waitFor(() => {
      expect(again.options?.localization.timeFormatter(usOpen)).toBe('21:30')
    })
    expect(again.options.timeScale.tickMarkFormatter(usClose, 3)).toBe('04:00')
    expect(screen.getByRole('button', { name: '北京' }).getAttribute('aria-pressed')).toBe('true')
  })
})
