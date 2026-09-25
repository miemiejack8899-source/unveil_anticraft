// identity.js — 进站身份检测（学生本人）会话
// 存在 localStorage：关闭网站后再进无需重新身份检测（后续靠令牌过期控制）

const TOKEN_KEY = 'student_token'
const STUDENT_KEY = 'student'

export function getStudentToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function getStudent() {
  try {
    return JSON.parse(localStorage.getItem(STUDENT_KEY) || 'null')
  } catch {
    return null
  }
}

export function saveIdentity(token, student) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(STUDENT_KEY, JSON.stringify(student))
}

export function clearIdentity() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(STUDENT_KEY)
}

// 登录账号的角色：登录响应与 /api/user/me 都会把用户信息写入 localStorage.user
export function getAccountRole() {
  try {
    const user = JSON.parse(localStorage.getItem('user') || 'null')
    return user && user.role ? user.role : ''
  } catch {
    return ''
  }
}

export function isAdminAccount() {
  return getAccountRole() === 'admin'
}
