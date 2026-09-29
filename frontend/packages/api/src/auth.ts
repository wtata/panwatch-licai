import { fetchAPI } from './client'

export interface AuthStatus {
  initialized: boolean
}

export interface AuthTokenPayload {
  token: string
  expires_at: string
  must_change_password?: boolean
}

export interface AuthMe {
  user: string
  must_change_password: boolean
}

export interface LoginPayload {
  username: string
  password: string
}

export const authApi = {
  status: () => fetchAPI<AuthStatus>('/auth/status'),
  login: (payload: LoginPayload) =>
    fetchAPI<AuthTokenPayload>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  setup: (payload: LoginPayload) =>
    fetchAPI<AuthTokenPayload>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  me: () => fetchAPI<AuthMe>('/auth/me'),
  changePassword: (password: string) =>
    fetchAPI<{ message: string; must_change_password: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
}
