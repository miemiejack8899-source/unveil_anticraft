// api.js — fetch 封装：统一携带 Bearer 鉴权头；401 自动清凭证并回登录页
// 登录 / 注册 / 重置密码等 401 属正常业务响应的公开接口不要走 apiFetch。

import { clearIdentity, getStudentToken } from './identity'

export function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` }
}

export async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (localStorage.getItem('token')) Object.assign(headers, authHeaders())
  const res = await fetch(url, { ...opts, headers })
  if (res.status === 401) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.location.href = '/auth'
    throw new Error('未登录或登录已过期')
  }
  return res
}

// 身份检测（学生本人）请求：带学生令牌；令牌失效则清身份并回到进站检测页
export async function studentFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${getStudentToken()}` }
  const res = await fetch(url, { ...opts, headers })
  if (res.status === 401) {
    clearIdentity()
    window.location.href = '/'
    throw new Error('身份已失效，请重新检测')
  }
  return res
}
