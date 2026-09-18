import { fetchAPI } from './client'

export interface LearningCard {
  id: string
  kicker: string
  title: string
  body: string
  points: string[]
}

export const learningApi = {
  cards: () => fetchAPI<{ items: LearningCard[] }>('/learning/cards'),
}
