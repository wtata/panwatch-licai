import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ScreenshotImportModal from '@/components/holdings/ScreenshotImportModal'

const { fetchAPI, stocksApi } = vi.hoisted(() => ({
  fetchAPI: vi.fn(),
  stocksApi: {
    list: vi.fn(),
    create: vi.fn(),
  },
}))

vi.mock('@panwatch/api', () => ({
  fetchAPI,
  stocksApi,
}))

describe('ScreenshotImportModal', () => {
  beforeEach(() => {
    fetchAPI.mockReset()
    stocksApi.list.mockReset()
    stocksApi.create.mockReset()
    fetchAPI.mockImplementation(async (path: string) => {
      if (String(path).startsWith('/stocks/search')) return []
      return { id: 1 }
    })
    stocksApi.create.mockResolvedValue({ id: 8, symbol: '600519', name: '贵州茅台', market: 'CN' })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:holdings-preview',
      revokeObjectURL: () => {},
    })
  })

  it('parses an uploaded screenshot and writes selected rows to the chosen account', async () => {
    const user = userEvent.setup()
    const onImported = vi.fn()
    const recognizeImage = vi.fn().mockResolvedValue({
      text: '600519 贵州茅台 100 1423.56',
      words: [],
    })

    render(
      <ScreenshotImportModal
        open
        onOpenChange={vi.fn()}
        accounts={[{ id: 3, name: '华宝证券' }]}
        defaultAccountId={3}
        existingStocks={[]}
        existingPositions={[]}
        onImported={onImported}
        recognizeImage={recognizeImage}
      />,
    )

    expect(screen.getByText('截图导入持仓')).toBeTruthy()
    const file = new File(['fake-image'], 'holdings.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByDisplayValue('600519')).toBeTruthy()
    expect(screen.getByDisplayValue('贵州茅台')).toBeTruthy()
    expect(screen.getByDisplayValue('100')).toBeTruthy()
    expect(screen.getByDisplayValue('1423.56')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /确认导入/ }))

    await waitFor(() => {
      expect(stocksApi.create).toHaveBeenCalledWith({ symbol: '600519', name: '贵州茅台', market: 'CN' })
      expect(fetchAPI).toHaveBeenCalledWith('/positions', {
        method: 'POST',
        body: JSON.stringify({
          account_id: 3,
          stock_id: 8,
          cost_price: 1423.56,
          quantity: 100,
        }),
      })
      expect(onImported).toHaveBeenCalled()
    })
  })

  it('fills the security code after the user edits a stock name', async () => {
    const user = userEvent.setup()
    let nameSearches = 0
    fetchAPI.mockImplementation(async (path: string) => {
      const query = String(path)
      if (query.includes('/stocks/search')) {
        if (decodeURIComponent(query).includes('多氟多')) {
          nameSearches += 1
          if (nameSearches === 1) return []
          return [{ symbol: '002407', name: '多氟多', market: 'CN' }]
        }
        return []
      }
      return { id: 1 }
    })
    const recognizeImage = vi.fn().mockResolvedValue({
      text: '多氟多 -12.08 100 36.208',
      words: [],
    })

    render(
      <ScreenshotImportModal
        open
        onOpenChange={vi.fn()}
        accounts={[{ id: 3, name: '华宝证券' }]}
        defaultAccountId={3}
        existingStocks={[]}
        existingPositions={[]}
        onImported={vi.fn()}
        recognizeImage={recognizeImage}
      />,
    )

    const file = new File(['fake-image'], 'holdings.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })

    const nameInput = await screen.findByDisplayValue('多氟多')
    expect(screen.queryByDisplayValue('002407')).toBeNull()
    await user.clear(nameInput)
    await user.type(nameInput, '多氟多')
    fireEvent.blur(nameInput)

    expect(await screen.findByDisplayValue('002407')).toBeTruthy()
  })
})
