import { fetchAPI } from '@panwatch/api'
import { holdingsFromVisionItems, parseHoldings, preferOcrHoldings } from './parseHoldings'
import { canvasToJpeg, cropHoldingsCanvas, recognizeHoldingsImage, type RecognizeProgress, type RecognizeResult } from './recognize'
import type { ParsedHolding } from './types'

export interface ScanHoldingsResult extends RecognizeResult {
  holdings: ParsedHolding[]
  source: 'vision' | 'ocr'
}

const MAX_BYTES = 5 * 1024 * 1024

function blobToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取截图失败'))
    reader.readAsDataURL(file)
  })
}

export async function scanHoldingsViaVision(file: Blob): Promise<ParsedHolding[]> {
  if (file.size > MAX_BYTES) {
    throw new Error('图片超过 5MB，请裁切持仓表格后再试')
  }
  const image = await blobToDataUrl(file)
  const data = await fetchAPI<{ items?: Array<Record<string, unknown>>; source?: string }>(
    '/portfolio/screenshot-scan',
    {
      method: 'POST',
      body: JSON.stringify({ image }),
      timeoutMs: 60000,
    },
  )
  return holdingsFromVisionItems(data.items || [])
}

export async function scanHoldingsImage(
  file: Blob,
  onProgress?: (info: RecognizeProgress) => void,
): Promise<ScanHoldingsResult> {
  onProgress?.({ progress: 0.04, status: '正在裁切持仓区域' })
  let prepared = file
  try {
    prepared = await canvasToJpeg(await cropHoldingsCanvas(file))
  } catch {
    prepared = file
  }

  let visionHoldings: ParsedHolding[] = []
  onProgress?.({ progress: 0.08, status: '正在用视觉模型读取持仓列' })
  try {
    visionHoldings = await scanHoldingsViaVision(prepared)
  } catch {
    // 未配置多模态模型或接口失败时，回退本地 OCR。
  }

  const ocr = await recognizeHoldingsImage(prepared, onProgress)
  const ocrHoldings = parseHoldings(ocr)
  const holdings = preferOcrHoldings(ocrHoldings, visionHoldings)
  onProgress?.({ progress: 1, status: '识别完成' })
  return {
    ...ocr,
    holdings,
    source: ocrHoldings.length >= 5 ? 'ocr' : visionHoldings.length ? 'vision' : 'ocr',
  }
}
