/** 登录态决定下一跳。null 表示停在当前页。 */
export function nextPathForAuth(options: {
  pathname: string
  authenticated: boolean
  mustChangePassword: boolean
}): '/login' | '/change-password' | null {
  if (!options.authenticated) {
    return options.pathname === '/login' ? null : '/login'
  }
  if (options.mustChangePassword && options.pathname !== '/change-password') {
    return '/change-password'
  }
  return null
}
