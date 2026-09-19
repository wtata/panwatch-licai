import type { OcrWord } from './types'

export interface RecognizeProgress {
  progress: number
  status: string
}

export interface RecognizeResult {
  text: string
  words: OcrWord[]
}

const TESSERACT_VERSION = '5.1.1'

function statusLabel(status: string): string {
  if (status.includes('loading tesseract core')) return '加载识别引擎'
  if (status.includes('initializing tesseract')) return '初始化识别引擎'
  if (status.includes('loading language')) return '加载中文识别模型（首次较慢）'
  if (status.includes('initializing api')) return '准备识别'
  if (status.includes('recognizing')) return '正在识别文字'
  return '处理中'
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}

export function findDarkContentBox(
  width: number,
  height: number,
  grayAt: (x: number, y: number) => number,
): { x: number; y: number; w: number; h: number } | null {
  if (width < 80 || height < 80) return null
  const stepY = Math.max(1, Math.floor(height / 180))
  const stepX = Math.max(1, Math.floor(width / 220))
  const colScore = new Float64Array(width)
  let darkSamples = 0
  let samples = 0
  for (let x = 0; x < width; x += stepX) {
    let dark = 0
    let rows = 0
    for (let y = 0; y < height; y += stepY) {
      samples += 1
      rows += 1
      if (grayAt(x, y) < 85) {
        darkSamples += 1
        dark += 1
      }
    }
    const fill = dark / Math.max(1, rows)
    for (let dx = 0; dx < stepX && x + dx < width; dx++) colScore[x + dx] = fill
  }
  if (darkSamples / Math.max(1, samples) > 0.5) return null

  let bestLo = 0
  let bestHi = -1
  let lo = -1
  for (let x = 0; x < width; x++) {
    if (colScore[x] >= 0.1) {
      if (lo < 0) lo = x
    } else if (lo >= 0) {
      if (x - 1 - lo > bestHi - bestLo) {
        bestLo = lo
        bestHi = x - 1
      }
      lo = -1
    }
  }
  if (lo >= 0 && width - 1 - lo > bestHi - bestLo) {
    bestLo = lo
    bestHi = width - 1
  }
  const boxW = bestHi - bestLo + 1
  if (bestHi < bestLo || boxW < 60 || boxW > width * 0.82) return null

  let minY = height
  let maxY = 0
  for (let y = 0; y < height; y += stepY) {
    let hit = false
    for (let x = bestLo; x <= bestHi; x += stepX) {
      if (grayAt(x, y) < 85) {
        hit = true
        break
      }
    }
    if (hit) {
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxY <= minY) return null
  const padX = Math.round(boxW * 0.04)
  const padY = Math.round((maxY - minY) * 0.02)
  const x = Math.max(0, bestLo - padX)
  const y = Math.max(0, minY - padY)
  const w = Math.min(width - x, boxW + padX * 2)
  const h = Math.min(height - y, maxY - minY + padY * 2)
  if (w < 50 || h < 80) return null
  return { x, y, w, h }
}

async function canvasFromBlob(file: Blob): Promise<HTMLCanvasElement> {
  const img = await loadImage(file)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, 0, 0)
  return canvas
}

export async function cropHoldingsCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const src = await canvasFromBlob(file)
  const ctx = src.getContext('2d')
  if (!ctx) return src
  const imageData = ctx.getImageData(0, 0, src.width, src.height)
  const grayAt = (x: number, y: number) => {
    const i = (y * src.width + x) * 4
    return 0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2]
  }
  const box = findDarkContentBox(src.width, src.height, grayAt)
  if (!box) return src
  const cropped = document.createElement('canvas')
  cropped.width = box.w
  cropped.height = box.h
  const croppedCtx = cropped.getContext('2d')
  if (!croppedCtx) return src
  croppedCtx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return cropped
}

export async function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('截图编码失败'))
    }, 'image/jpeg', quality)
  })
}

export async function preprocessImage(file: Blob): Promise<HTMLCanvasElement> {
  const cropped = await cropHoldingsCanvas(file)
  const maxEdge = 2800
  const natural = Math.max(cropped.width, cropped.height)
  const scale = natural < 1200 ? 2 : natural > maxEdge ? maxEdge / natural : 1.4
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(cropped.width * scale))
  canvas.height = Math.max(1, Math.round(cropped.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cropped, 0, 0, canvas.width, canvas.height)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  let min = 255
  let max = 0
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    if (gray < min) min = gray
    if (gray > max) max = gray
  }
  const range = Math.max(1, max - min)
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const stretched = ((gray - min) / range) * 255
    const contrasted = Math.min(255, Math.max(0, (stretched - 128) * 1.35 + 128))
    data[i] = data[i + 1] = data[i + 2] = contrasted
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

export async function recognizeHoldingsImage(
  file: Blob,
  onProgress?: (info: RecognizeProgress) => void,
): Promise<RecognizeResult> {
  onProgress?.({ progress: 0.02, status: '正在预处理截图' })
  const canvas = await preprocessImage(file)
  onProgress?.({ progress: 0.08, status: '预处理完成' })

  const tesseract = await import('tesseract.js')
  const worker = await tesseract.createWorker('chi_sim+eng', 1, {
    workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@v${TESSERACT_VERSION}/dist/worker.min.js`,
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1',
    logger: (message) => {
      if (!message) return
      const ratio = typeof message.progress === 'number' ? message.progress : 0
      const progress = message.status === 'recognizing text'
        ? 0.15 + ratio * 0.8
        : Math.min(0.15, 0.08 + ratio * 0.07)
      onProgress?.({ progress, status: statusLabel(message.status || '') })
    },
  })

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
    })
    const { data } = await worker.recognize(canvas)
    const words: OcrWord[] = (data.words || [])
      .map((word) => ({
        text: (word.text || '').trim(),
        confidence: word.confidence ?? 0,
        bbox: word.bbox,
      }))
      .filter((word) => word.text)
    onProgress?.({ progress: 1, status: '识别完成' })
    return { text: data.text || '', words }
  } finally {
    await worker.terminate()
  }
}

export async function readClipboardImage(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (!type) continue
      const blob = await item.getType(type)
      const ext = type.split('/')[1] || 'png'
      return new File([blob], `clipboard.${ext}`, { type: blob.type || type })
    }
  } catch {
    return null
  }
  return null
}

export function fileFromPasteEvent(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items
  if (!items) return null
  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  const files = event.clipboardData?.files
  if (files && files.length > 0 && files[0].type.startsWith('image/')) return files[0]
  return null
}
