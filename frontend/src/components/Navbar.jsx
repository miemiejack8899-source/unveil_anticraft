import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import NavItem from './NavItem'
import { navItems as featureNavItems } from '../appRoutes'
import { t } from '../i18n'
import { apiFetch } from '../utils/api'
import { clearIdentity, getStudent } from '../utils/identity'

// 本系统只保留与班级团组织信息相关的入口；
// 样式类名与 anticraft 完全一致，外观不变。
function Navbar({ activePage }) {
  const navigate = useNavigate()
  const [user, setUser] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false) // 移动端抽屉菜单开合

  // 抽屉打开时锁定背景滚动，关闭时恢复
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  useEffect(() => {
    const sync = () => {
      const raw = localStorage.getItem('user')
      if (raw) {
        try { setUser(JSON.parse(raw)) } catch { setUser(null) }
      } else { setUser(null) }
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // 校验当前登录用户的账户是否仍存在；被删除则清除本地登录态
  useEffect(() => {
    const token = localStorage.getItem('token')
    const storedUser = localStorage.getItem('user')
    if (!token || !storedUser) return
    let cancelled = false
    apiFetch('/api/user/me')
      .then(r => {
        if (cancelled) return null
        if (r.status === 404) {
          localStorage.removeItem('token')
          localStorage.removeItem('user')
          setUser(null)
          window.dispatchEvent(new StorageEvent('storage', { key: 'user' }))
          return null
        }
        return r.ok ? r.json() : null
      })
      .then(data => {
        if (cancelled || !data) return
        localStorage.setItem('user', JSON.stringify(data))
        setUser(data)
      })
      .catch(() => {
        // 网络错误时静默处理，不打扰用户
      })
    return () => { cancelled = true }
  }, [])

  const getInitial = (name) => (name ? name.charAt(0).toUpperCase() : '?')

  const closeMenu = () => setMenuOpen(false)

  // 学生本人（进站身份检测）不是账号，单独处理显示与退出
  const student = getStudent()

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    clearIdentity()
    setUser(null)
    closeMenu()
    navigate('/')
  }

  const exitIdentity = () => {
    clearIdentity()
    closeMenu()
    navigate('/')
  }

  // 导航栏目（桌面导航栏与移动端抽屉共用同一组，点击链接后关闭抽屉）
  // 栏目文字按角色变化：管理员账号显示“管理员”，其余（学生本人/普通账号）显示“普通用户”
  const roleKey = user ? user.role : (student ? 'user' : '')
  const itemLabel = item => (roleKey && item.roleLabels ? item.roleLabels[roleKey] : null) || item.label

  const navItems = (
    <>
      {featureNavItems.map(item => (
        <NavItem key={item.path} label={itemLabel(item)} to={item.path} onNavigate={closeMenu} />
      ))}
    </>
  )

  // 登录 / 用户区（导航栏与抽屉共用）
  const userArea = user ? (
    <div className="nav-user">
      <span className="nav-user-avatar" title={user.nickname || user.username}>
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="nav-avatar-img" />
        ) : (
          <span className="nav-avatar-letter">
            {getInitial(user.nickname || user.username)}
          </span>
        )}
      </span>
      <button type="button" className="nav-login-btn" onClick={logout}>退出登录</button>
    </div>
  ) : student ? (
    <div className="nav-user">
      <span className="nav-user-avatar" title={`${student.name} · ${student.student_id}`}>
        <span className="nav-avatar-letter">{getInitial(student.name)}</span>
      </span>
      <button type="button" className="nav-login-btn" onClick={exitIdentity}>退出身份</button>
    </div>
  ) : (
    <Link to="/login" className="nav-login-btn" onClick={closeMenu}>{t('nav.login')}</Link>
  )

  return (
    <nav className="navbar">
      <div className="nav-inner">
        <Link to="/" className="nav-logo">
          <img src="/favicon.svg" alt="anticraft" className="logo-icon" />
          <span className="logo-text">anticraft</span>
        </Link>
        <button
          type="button"
          className="nav-hamburger"
          aria-label={t('nav.openMenu')}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? '✕' : '☰'}
        </button>
        <div className="nav-right">
          <div className="nav-links">{navItems}</div>
          {userArea}
        </div>
      </div>
      {/* 移动端抽屉式侧边栏（≤768px 显示，桌面端 display:none 不参与布局）。
          portal 到 body：navbar 的 backdrop-filter/transform 会改变 fixed 子元素的 containing block */}
      {createPortal(
        <>
          <div className={`nav-drawer ${menuOpen ? 'open' : ''}`}>
            <div className="nav-drawer-links">{navItems}</div>
            <div className="nav-drawer-user">{userArea}</div>
          </div>
          <div className={`nav-drawer-overlay ${menuOpen ? 'show' : ''}`} onClick={closeMenu} />
        </>,
        document.body
      )}
    </nav>
  )
}

export default Navbar
