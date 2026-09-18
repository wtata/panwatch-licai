import { fetchAPI } from './client'

export type JournalType = 'buy' | 'reduce' | 'watch' | 'review'

export interface DisciplineJournalEntry {
  id: number
  date: string
  symbol: string
  type: JournalType
  text: string
  created_at: string | null
}

export interface DisciplineRule {
  id: number
  text: string
  enabled: boolean
  created_at: string | null
  updated_at: string | null
}

export interface DisciplineSummary {
  rules: DisciplineRule[]
  journal: DisciplineJournalEntry[]
}

export const disciplineApi = {
  listJournal: (limit = 100) =>
    fetchAPI<{ items: DisciplineJournalEntry[] }>(`/discipline/journal?limit=${limit}`),

  createJournal: (body: { date: string; symbol?: string; type: JournalType; text: string }) =>
    fetchAPI<DisciplineJournalEntry>('/discipline/journal', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteJournal: (id: number) =>
    fetchAPI<{ success: boolean; id: number }>(`/discipline/journal/${id}`, {
      method: 'DELETE',
    }),

  listRules: () => fetchAPI<{ items: DisciplineRule[] }>('/discipline/rules'),

  createRule: (body: { text: string; enabled?: boolean }) =>
    fetchAPI<DisciplineRule>('/discipline/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateRule: (id: number, body: { text?: string; enabled?: boolean }) =>
    fetchAPI<DisciplineRule>(`/discipline/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteRule: (id: number) =>
    fetchAPI<{ success: boolean; id: number }>(`/discipline/rules/${id}`, {
      method: 'DELETE',
    }),

  summary: () => fetchAPI<DisciplineSummary>('/discipline/summary'),
}
