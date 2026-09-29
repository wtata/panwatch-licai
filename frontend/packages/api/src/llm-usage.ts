import { fetchAPI } from './client'

export interface LlmUsageItem {
  id: number
  day: string
  scene: string
  scene_label: string
  operation: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
  source: string
  agent_name: string
  trace_id: string
  created_at: string
}

export interface LlmUsageListResponse {
  items: LlmUsageItem[]
  total: number
}

export interface LlmUsageSceneBreakdown {
  scene: string
  scene_label: string
  calls: number
  total_tokens: number
  cost_usd: number
}

export interface LlmUsageDayBreakdown {
  day: string
  calls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
}

export interface LlmUsageSummary {
  today: LlmUsageSceneBreakdown
  month: LlmUsageSceneBreakdown
  by_day: LlmUsageDayBreakdown[]
  by_scene: LlmUsageSceneBreakdown[]
  scenes: Array<{ value: string; label: string }>
}

export const llmUsageApi = {
  list: (params?: { scene?: string; day?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams()
    if (params?.scene) q.set('scene', params.scene)
    if (params?.day) q.set('day', params.day)
    if (params?.limit) q.set('limit', String(params.limit))
    if (params?.offset) q.set('offset', String(params.offset))
    const qs = q.toString()
    return fetchAPI<LlmUsageListResponse>(`/llm-usage${qs ? `?${qs}` : ''}`)
  },
  summary: (days = 30) => fetchAPI<LlmUsageSummary>(`/llm-usage/summary?days=${days}`),
}
