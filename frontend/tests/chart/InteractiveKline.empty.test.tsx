import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import InteractiveKline from '@panwatch/biz-ui/components/InteractiveKline'

vi.mock('@panwatch/api', () => ({
  fetchAPI: vi.fn(),
}))

const fetchMock = fetchAPI as unknown as ReturnType<typeof vi.fn>

describe('InteractiveKline 空日K', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ symbol: '600719', market: 'CN', days: 120, interval: '1d', klines: [] })
  })

  it('行情源返回 0 根时给出空状态，而不是空白图', async () => {
    render(<InteractiveKline symbol="600719" market="CN" initialInterval="1d" />)
    expect(await screen.findByText('暂无K线数据。行情源暂时没有返回，可稍后刷新。')).toBeTruthy()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
  })
})
