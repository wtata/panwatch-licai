import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PASSWORD_CHANGE_REQUIRED_CODE } from '@panwatch/api'
import { nextPathForAuth } from '@/lib/auth-gate'
import LoginPage from '@/pages/Login'
import ChangePasswordPage from '@/pages/ChangePassword'

vi.mock('@panwatch/api', async () => {
  const actual = await vi.importActual<typeof import('@panwatch/api')>('@panwatch/api')
  return {
    ...actual,
    authApi: {
      status: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      me: vi.fn(),
      changePassword: vi.fn(),
    },
  }
})

import { authApi } from '@panwatch/api'

describe('password change gate', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(authApi.status).mockReset()
    vi.mocked(authApi.login).mockReset()
    vi.mocked(authApi.changePassword).mockReset()
  })

  it('keeps the backend error code for forced password change', () => {
    expect(PASSWORD_CHANGE_REQUIRED_CODE).toBe(4031)
  })

  it('sends an authenticated user who still uses the initial password to the change page', () => {
    expect(nextPathForAuth({
      pathname: '/',
      authenticated: true,
      mustChangePassword: true,
    })).toBe('/change-password')
    expect(nextPathForAuth({
      pathname: '/change-password',
      authenticated: true,
      mustChangePassword: true,
    })).toBeNull()
    expect(nextPathForAuth({
      pathname: '/portfolio',
      authenticated: false,
      mustChangePassword: false,
    })).toBe('/login')
  })

  it('redirects login to the change-password page when the server requires it', async () => {
    vi.mocked(authApi.status).mockResolvedValue({ initialized: true })
    vi.mocked(authApi.login).mockResolvedValue({
      token: 'token-placeholder',
      expires_at: '2099-01-01T00:00:00Z',
      must_change_password: true,
    })

    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/change-password" element={<div>force-change</div>} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.type(await screen.findByPlaceholderText('请输入用户名'), 'admin')
    await userEvent.type(screen.getByPlaceholderText('请输入密码'), 'init-placeholder')
    await userEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('force-change')).toBeTruthy()
    expect(localStorage.getItem('must_change_password')).toBe('1')
  })

  it('clears the flag after a successful password change', async () => {
    localStorage.setItem('must_change_password', '1')
    vi.mocked(authApi.changePassword).mockResolvedValue({
      message: '密码已更新',
      must_change_password: false,
    })

    render(
      <MemoryRouter initialEntries={['/change-password']}>
        <Routes>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.type(screen.getByPlaceholderText('至少 6 位，且不能与初始密码相同'), 'replaced-placeholder')
    await userEvent.type(screen.getByPlaceholderText('再次输入新密码'), 'replaced-placeholder')
    await userEvent.click(screen.getByRole('button', { name: '保存并进入' }))

    expect(await screen.findByText('home')).toBeTruthy()
    expect(localStorage.getItem('must_change_password')).toBeNull()
    expect(authApi.changePassword).toHaveBeenCalledWith('replaced-placeholder')
  })
})
