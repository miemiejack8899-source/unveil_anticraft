import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getStudentToken, isAdminAccount, saveIdentity } from '../utils/identity'
import './Auth.css'

// 进站身份检测：姓名 + 学号与名单比对，通过后以“学生本人”身份进入（只看/只改自己那条）
function IdentityPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [studentId, setStudentId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 已经通过身份检测、或当前是管理员账号，直接进系统
  useEffect(() => {
    if (isAdminAccount() || getStudentToken()) navigate('/tools/class-development', { replace: true })
  }, [navigate])

  const handleSubmit = async (event) => {
    event.preventDefault()
    const trimmedName = name.trim()
    const trimmedId = studentId.trim()
    if (!trimmedName || !trimmedId) {
      setError('请填写本人姓名和学号。')
      return
    }

    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/identity-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, student_id: trimmedId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.detail || '身份检测失败，请稍后重试。')
        return
      }
      saveIdentity(data.access_token, data.student)
      navigate('/tools/class-development', { replace: true })
    } catch {
      setError('网络连接失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-grid" />
      <div className="auth-glow ag-1" />
      <div className="auth-glow ag-2" />

      <div className="auth-container">
        <div className="auth-brand">
          <div className="auth-brand-content">
            <Link to="/" className="auth-brand-logo">
              <img src="/favicon.svg" alt="anticraft" className="brand-logo-img" />
            </Link>
            <h1 className="auth-brand-title">
              <span className="brand-title-en">anticraft</span>
              <span className="brand-title-cn">班级发展信息</span>
            </h1>
            <p className="auth-brand-desc">
              输入本人姓名与学号通过身份检测，即可填写并维护自己的团员发展情况。
            </p>
            <blockquote className="auth-brand-quote">
              &ldquo;先核对身份，再填写信息。<br />你只能看到并修改自己的记录。&rdquo;
            </blockquote>
          </div>
        </div>

        <div className="auth-form-wrap">
          <div className="auth-form-card">
            <div className="auth-form-header">
              <div className="auth-tabs">
                <button className="auth-tab active" type="button" disabled>身份检测</button>
              </div>
              <p className="auth-form-hint">姓名与学号来自班级名单，请与本人信息完全一致。</p>
            </div>

            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              {error && <div className="form-server-error">{error}</div>}

              <div className="form-group">
                <label className="form-label" htmlFor="identity-name">姓名</label>
                <div className="form-input-wrap">
                  <span className="form-input-icon">&#128100;</span>
                  <input
                    id="identity-name"
                    type="text"
                    className="form-input"
                    placeholder="请输入本人姓名"
                    value={name}
                    onChange={event => { setName(event.target.value); if (error) setError('') }}
                    autoComplete="off"
                    autoFocus
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="identity-student-id">学号</label>
                <div className="form-input-wrap">
                  <span className="form-input-icon">&#127891;</span>
                  <input
                    id="identity-student-id"
                    type="text"
                    className="form-input"
                    placeholder="请输入本人学号"
                    value={studentId}
                    onChange={event => { setStudentId(event.target.value); if (error) setError('') }}
                    autoComplete="off"
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
                {loading ? '正在核对…' : '进入'}
                {!loading && <span className="btn-arrow">&rarr;</span>}
              </button>

              <p className="auth-switch">
                管理员？<Link to="/auth" className="auth-switch-btn">账号登录</Link>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}

export default IdentityPage
