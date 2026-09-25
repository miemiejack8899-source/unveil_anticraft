import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Navbar from '../../components/Navbar'
import Modal from '../../components/Modal'
import { UiIcon } from '../../components/Icons'
import { apiFetch, studentFetch } from '../../utils/api'
import { getStudent, getStudentToken, isAdminAccount } from '../../utils/identity'
import '../../pages/ToolParsePage.css'
import './ClassDevelopmentPage.css'

const CLASS_OPTIONS = ['251184Y1', '251184Y2', '251184Y3', '251184Y4']

const STATUS_FIELDS = [
  'league_member',
  'league_activist',
  'league_application_submitted',
  'league_application_date',
  'party_activist',
  'recommended_for_party',
  'party_application_submitted',
  'party_application_date',
]

// 该学生是否已有发展信息（有才允许“清除数据”）
function hasDevelopmentData(record) {
  return STATUS_FIELDS.some(field => record[field] !== null && record[field] !== undefined)
}

function asNullableBoolean(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
    return null
  }
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return null
}

function dateValue(value) {
  if (!value) return ''
  return String(value).slice(0, 10)
}

function showDate(value) {
  return dateValue(value) || '未填写'
}

const EMPTY_DATE = { year: '', month: '', day: '' }

// 后端日期（YYYY-MM-DD）↔ 年/月/日 三段
function splitDate(value) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(dateValue(value))
  if (!match) return { ...EMPTY_DATE }
  return { year: match[1], month: String(Number(match[2])), day: String(Number(match[3])) }
}

function daysInMonth(year, month) {
  const y = Number(year) || 2000
  return new Date(y, Number(month), 0).getDate()
}

// 校验三段：任一段空缺或日期非法都视为无效（提交申请书=是时日期为必填）
function buildDate(parts) {
  const { year, month, day } = parts || EMPTY_DATE
  const invalid = { ok: false, value: null }
  if (year.length !== 4 || !month || !day) return invalid
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12) return invalid
  if (d < 1 || d > daysInMonth(year, month)) return invalid
  return { ok: true, value: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` }
}

// 当前分支是否需要校验日期（提交申请书=是才显示日期框）
function branchDateParts(draft) {
  if (!draft) return null
  if (draft.league_member === false && draft.league_application_submitted === true) {
    return draft.league_application_date
  }
  if (draft.league_member === true && draft.party_application_submitted === true) {
    return draft.party_application_date
  }
  return null
}

// 表单逐项必填：返回未选的项，空数组表示“是否…”都已选择
function draftProblems(draft) {
  if (!draft) return ['请先打开需要编辑的学生']
  const problems = []
  const member = draft.league_member
  if (member === null || member === undefined) {
    problems.push('请选择是否为团员')
    return problems
  }
  if (member === true) {
    if (draft.party_activist === null || draft.party_activist === undefined) problems.push('请选择是否为入党积极分子')
    if (draft.recommended_for_party === null || draft.recommended_for_party === undefined) problems.push('请选择是否推优')
    if (draft.party_application_submitted === null || draft.party_application_submitted === undefined) {
      problems.push('请选择是否提交入党申请书')
    }
  } else {
    if (draft.league_activist === null || draft.league_activist === undefined) problems.push('请选择是否为入团积极分子')
    if (draft.league_application_submitted === null || draft.league_application_submitted === undefined) {
      problems.push('请选择是否提交入团申请书')
    }
  }
  return problems
}

async function errorText(response, fallback) {
  const body = await response.json().catch(() => null)
  if (body && body.detail) {
    return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  }
  return fallback
}

function StatusLine({ label, value, date }) {
  const status = asNullableBoolean(value)
  return (
    <div className="cd-status-line">
      <span className="cd-status-label">{label}</span>
      <span className={`cd-status-value${status === true ? ' is-yes' : status === false ? ' is-no' : ' is-unset'}`}>
        {status === null ? '未填写' : status ? '是' : '否'}
      </span>
      {status === true && <span className="cd-status-date">{showDate(date)}</span>}
    </div>
  )
}

function BooleanField({ label, name, value, onChange }) {
  return (
    <label className="cd-field">
      <span>{label}</span>
      <select
        className="tool-input cd-control"
        value={value === null || value === undefined ? '' : value ? 'true' : 'false'}
        onChange={event => onChange(name, event.target.value === '' ? null : event.target.value === 'true')}
      >
        <option value="">未填写</option>
        <option value="false">否</option>
        <option value="true">是</option>
      </select>
    </label>
  )
}

function DateField({ label, name, value, onChange }) {
  const parts = value && typeof value === 'object' ? value : EMPTY_DATE
  const yearRef = useRef(null)
  const monthRef = useRef(null)
  const dayRef = useRef(null)

  const updatePart = (part, raw) => {
    // 只保留数字并限位（年 4 位、月/日 2 位），支持手动逐段输入
    const limit = part === 'year' ? 4 : 2
    const digits = String(raw).replace(/\D/g, '').slice(0, limit)
    onChange(name, { ...parts, [part]: digits })
    if (part === 'year' && digits.length === 4) monthRef.current?.focus()
    if (part === 'month' && (digits.length === 2 || Number(digits) > 1)) dayRef.current?.focus()
  }

  const goBack = (part, event) => {
    if (event.key !== 'Backspace' || parts[part]) return
    if (part === 'month') yearRef.current?.focus()
    if (part === 'day') monthRef.current?.focus()
  }

  return (
    <label className="cd-field">
      <span>{label}</span>
      <div className="cd-date-parts">
        <div className="cd-date-col">
          <input
            ref={yearRef}
            className="tool-input cd-control cd-date-part cd-date-year"
            inputMode="numeric"
            autoComplete="off"
            placeholder="YYYY"
            aria-label={`${label}（年）`}
            value={parts.year}
            onChange={event => updatePart('year', event.target.value)}
          />
          <span className="cd-date-unit" aria-hidden="true">年</span>
        </div>
        <div className="cd-date-col">
          <input
            ref={monthRef}
            className="tool-input cd-control cd-date-part cd-date-short"
            inputMode="numeric"
            autoComplete="off"
            placeholder="MM"
            aria-label={`${label}（月）`}
            value={parts.month}
            onChange={event => updatePart('month', event.target.value)}
            onKeyDown={event => goBack('month', event)}
          />
          <span className="cd-date-unit" aria-hidden="true">月</span>
        </div>
        <div className="cd-date-col">
          <input
            ref={dayRef}
            className="tool-input cd-control cd-date-part cd-date-short"
            inputMode="numeric"
            autoComplete="off"
            placeholder="DD"
            aria-label={`${label}（日）`}
            value={parts.day}
            onChange={event => updatePart('day', event.target.value)}
            onKeyDown={event => goBack('day', event)}
          />
          <span className="cd-date-unit" aria-hidden="true">日</span>
        </div>
      </div>
      {!buildDate(parts).ok && (
        <span className="cd-date-hint" role="alert">请输入合理日期</span>
      )}
    </label>
  )
}

export default function ClassDevelopmentPage() {
  const navigate = useNavigate()
  // 管理员（账号登录）看全班；学生本人（身份检测）只看自己那条
  const isAdmin = isAdminAccount()
  const student = isAdmin ? null : getStudent()
  const token = isAdmin ? localStorage.getItem('token') : getStudentToken()
  const callApi = isAdmin ? apiFetch : studentFetch
  const fileInputRef = useRef(null)
  const autoClassRef = useRef(false)

  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(null)
  const [editError, setEditError] = useState('')
  const [clearTarget, setClearTarget] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [selectedClass, setSelectedClass] = useState(CLASS_OPTIONS[0])
  const [classOpen, setClassOpen] = useState(false)

  // 页面级提示：悬浮在页面上方，3 秒后自动消失；右侧 × 可立即关闭
  const showToast = useCallback((type, text) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ type, text })
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, 3000)
  }, [])

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    setToast(null)
  }, [])

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }, [])

  // 既不是管理员、也没通过身份检测：回到进站检测页
  useEffect(() => {
    if (!isAdmin && !token) navigate('/', { replace: true })
  }, [isAdmin, token, navigate])

  const loadRecords = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await callApi('/api/class-development')
      if (!response.ok) {
        showToast('error', await errorText(response, '读取班级名单失败，请稍后重试。'))
        return
      }
      const body = await response.json()
      setRecords(Array.isArray(body.records) ? body.records : [])
    } catch (err) {
      showToast('error', err && err.message ? err.message : '网络连接失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [callApi, showToast, token])

  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  // 各班人数（按记录里的班级字段归集）
  const classCounts = useMemo(() => {
    const counts = Object.fromEntries(CLASS_OPTIONS.map(cls => [cls, 0]))
    records.forEach(record => {
      const cls = String(record.class_name || '').trim()
      if (cls in counts) counts[cls] += 1
    })
    return counts
  }, [records])

  // 首次加载后，默认落在有名单的班级上；用户手动切换后不再改动（学生本人不需要切班）
  useEffect(() => {
    if (autoClassRef.current || records.length === 0) return
    autoClassRef.current = true
    const withData = CLASS_OPTIONS.find(cls => records.some(record => String(record.class_name || '').trim() === cls))
    if (withData) setSelectedClass(withData)
  }, [records])

  // 学生本人接口只返回自己那条，不参与班级筛选
  const classRecords = useMemo(
    () => (isAdmin
      ? records.filter(record => String(record.class_name || '').trim() === selectedClass)
      : records),
    [isAdmin, records, selectedClass],
  )

  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return classRecords
    return classRecords.filter(record =>
      String(record.name || '').toLocaleLowerCase().includes(needle) ||
      String(record.student_id || '').toLocaleLowerCase().includes(needle),
    )
  }, [classRecords, query])

  // 表单逐项必填 + 日期合法：任一不满足就禁用“保存修改”
  const problems = useMemo(() => draftProblems(draft), [draft])
  const dateInvalid = useMemo(() => {
    const parts = branchDateParts(draft)
    return parts !== null && !buildDate(parts).ok
  }, [draft])
  const canSave = problems.length === 0 && !dateInvalid

  const startEditing = record => {
    const nextDraft = Object.fromEntries(STATUS_FIELDS.map(field => [field, record[field]]))
    nextDraft.league_member = asNullableBoolean(record.league_member)
    nextDraft.league_activist = asNullableBoolean(record.league_activist)
    nextDraft.league_application_submitted = asNullableBoolean(record.league_application_submitted)
    nextDraft.league_application_date = splitDate(record.league_application_date)
    nextDraft.party_activist = asNullableBoolean(record.party_activist)
    nextDraft.recommended_for_party = asNullableBoolean(record.recommended_for_party)
    nextDraft.party_application_submitted = asNullableBoolean(record.party_application_submitted)
    nextDraft.party_application_date = splitDate(record.party_application_date)
    setEditing(record)
    setDraft(nextDraft)
    setEditError('')
  }

  const changeDraft = (name, value) => {
    setDraft(previous => ({ ...previous, [name]: value }))
  }

  const closeEditor = () => {
    if (saving) return
    setEditing(null)
    setDraft(null)
  }

  const saveRecord = async () => {
    if (!editing || !draft || !canSave) return
    // 只提交当前分支真正需要的日期；其余由后端按分支清空
    const leagueDate = draft.league_member === false && draft.league_application_submitted === true
      ? buildDate(draft.league_application_date)
      : { value: null }
    const partyDate = draft.league_member === true && draft.party_application_submitted === true
      ? buildDate(draft.party_application_date)
      : { value: null }
    setSaving(true)
    setEditError('')
    try {
      const payload = {
        ...draft,
        league_application_date: leagueDate.value,
        party_application_date: partyDate.value,
      }
      const response = await callApi(`/api/class-development/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        setEditError(await errorText(response, '保存失败，请检查填写内容后重试。'))
        return
      }
      setEditing(null)
      setDraft(null)
      showToast('success', `已保存 ${editing.name} 的发展信息。`)
      await loadRecords()
    } catch (err) {
      setEditError(err && err.message ? err.message : '网络连接失败，保存未完成。')
    } finally {
      setSaving(false)
    }
  }

  const importFile = async event => {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    if (!/\.xlsx$/i.test(file.name)) {
      showToast('error', '请选择 .xlsx 格式的 Excel 文件。')
      return
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('class_name', selectedClass)
    setImporting(true)
    try {
      const response = await callApi('/api/class-development/import', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        showToast('error', await errorText(response, '导入失败，请检查 Excel 文件后重试。'))
        return
      }
      const body = await response.json()
      showToast('success', `已导入到 ${selectedClass}：新增 ${body.added ?? 0} 人，更新 ${body.updated ?? 0} 人，名单共 ${body.total ?? 0} 人。重复导入会保留已有发展记录。`)
      await loadRecords()
    } catch (err) {
      showToast('error', err && err.message ? err.message : '网络连接失败，导入未完成。')
    } finally {
      setImporting(false)
    }
  }

  const clearRecord = async () => {
    if (!clearTarget) return
    const target = clearTarget
    setClearing(true)
    try {
      const response = await callApi(`/api/class-development/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(STATUS_FIELDS.map(field => [field, null]))),
      })
      if (!response.ok) {
        showToast('error', await errorText(response, '清除失败，请稍后重试。'))
        return
      }
      showToast('success', `已清除 ${target.name} 的发展信息。`)
      await loadRecords()
    } catch (err) {
      showToast('error', err && err.message ? err.message : '网络连接失败，清除未完成。')
    } finally {
      setClearing(false)
      setClearTarget(null)
    }
  }

  // 删除学生信息（仅管理员）：一人时用于行内垃圾桶，多人时用于表头“一键删除”
  const askDelete = targets => {
    if (targets.length === 0) return
    if (targets.length === 1) {
      const record = targets[0]
      setPendingDelete({
        ids: [record.id],
        name: record.name,
        title: `删除学生信息 · ${record.name}`,
        message: `确认删除 ${record.name}（${record.class_name || '班级未填写'} · 学号 ${record.student_id || '—'}）的学生信息吗？该学生的团员发展记录会一并删除，且不可撤销。`,
      })
      return
    }
    setPendingDelete({
      ids: targets.map(record => record.id),
      name: '',
      title: '一键删除学生信息',
      message: `确认删除当前列表显示的 ${targets.length} 名学生（${selectedClass}）吗？他们的团员发展记录会一并删除，且不可撤销。`,
    })
  }

  const deleteRecords = async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setDeleting(true)
    try {
      const response = await callApi('/api/class-development/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: target.ids }),
      })
      if (!response.ok) {
        showToast('error', await errorText(response, '删除失败，请稍后重试。'))
        return
      }
      const body = await response.json()
      showToast('success', target.name
        ? `已删除 ${target.name} 的学生信息。`
        : `已删除当前列表的 ${body.deleted ?? target.ids.length} 名学生。`)
      await loadRecords()
    } catch (err) {
      showToast('error', err && err.message ? err.message : '网络连接失败，删除未完成。')
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const exportExcel = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams({ class_name: selectedClass })
      if (query.trim()) params.set('q', query.trim())
      const response = await callApi(`/api/class-development/export?${params.toString()}`)
      if (!response.ok) {
        showToast('error', await errorText(response, '导出失败，请稍后重试。'))
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${selectedClass}-发展信息-${new Date().toISOString().slice(0, 10)}.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      showToast('success', `已导出 ${selectedClass} 共 ${filteredRecords.length} 人的名单与发展情况。`)
    } catch (err) {
      showToast('error', err && err.message ? err.message : '网络连接失败，导出未完成。')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="tool-page cd-page">
      <Navbar activePage="tools" />
      <main className="tool-main">
        <header className="tool-header">
          <h1 className="tool-title">班级发展信息</h1>
          <p className="tool-subtitle">维护全班同学的团员发展情况。导入只保存姓名、班级和学号，不保存手机号、签到和备注。</p>
        </header>

        {!token ? (
          <div className="tool-login-hint">登录后即可查看和维护班级发展信息。</div>
        ) : (
          <>
            <section className="cd-toolbar" aria-label="名单管理">
              <div className={`cd-class-select${classOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className={`cd-class-toggle${isAdmin ? '' : ' is-locked'}`}
                  aria-expanded={isAdmin ? classOpen : false}
                  onClick={() => {
                    // 切换班级需要管理员权限，学生本人只能看自己那条
                    if (!isAdmin) {
                      showToast('error', '权限不够')
                      return
                    }
                    setClassOpen(open => !open)
                  }}
                >
                  <span className="cd-class-name">{isAdmin ? selectedClass : (student?.class_name || '我的班级')}</span>
                  <span className="cd-class-count">
                    {isAdmin
                      ? `共 ${classCounts[selectedClass] ?? 0} 人${query.trim() ? ` · 当前显示 ${filteredRecords.length} 人` : ''}`
                      : '只显示本人信息'}
                  </span>
                  {isAdmin && <UiIcon name="chevronDown" size={16} className="cd-class-caret" />}
                </button>
                {isAdmin && classOpen && (
                  <ul className="cd-class-options">
                    {CLASS_OPTIONS.map(cls => (
                      <li key={cls}>
                        <button
                          type="button"
                          className={`cd-class-option${cls === selectedClass ? ' is-active' : ''}`}
                          onClick={() => {
                            setSelectedClass(cls)
                            setClassOpen(false)
                          }}
                        >
                          <span className="cd-class-name">{cls}</span>
                          <span className="cd-class-count">{classCounts[cls] ?? 0} 人</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="cd-actions">
                {isAdmin && (
                  <>
                    <input
                      ref={fileInputRef}
                      className="cd-file-input"
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={importFile}
                      aria-label="选择 Excel 名单文件"
                    />
                    <button
                      type="button"
                      className="btn btn-primary cd-import-btn"
                      disabled={importing}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {importing ? '正在导入…' : '导入 Excel'}
                    </button>
                  </>
                )}
                <label className="cd-search-label" htmlFor="cd-search">搜索姓名或学号</label>
                <input
                  id="cd-search"
                  className={`tool-input cd-search${isAdmin ? '' : ' is-locked'}`}
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={isAdmin ? '输入姓名或学号' : '搜索（需管理员权限）'}
                  readOnly={!isAdmin}
                  onFocus={event => {
                    if (isAdmin) return
                    event.target.blur()
                    showToast('error', '权限不够')
                  }}
                />
                {isAdmin && (
                  <button
                    type="button"
                    className="btn btn-secondary cd-export-btn"
                    disabled={exporting || filteredRecords.length === 0}
                    onClick={exportExcel}
                  >
                    {exporting ? '正在导出…' : '导出 Excel'}
                  </button>
                )}
              </div>
              {isAdmin ? (
                <p className="cd-import-hint">支持 .xlsx。名单导入到当前选中的班级 {selectedClass}（保存姓名、班级、学号）；重复导入只更新名单信息，已有发展记录会保留。</p>
              ) : (
                <p className="cd-import-hint">
                  当前身份：{student?.name || '本人'}（学号 {student?.student_id || '—'} · {student?.class_name || '班级未填写'}）。你只能查看和填写自己的发展信息，切换班级、搜索、导入导出与删除都需要管理员权限。
                </p>
              )}
            </section>

            <section className="cd-table-card" aria-label="学生发展情况名单">
              {loading ? (
                <div className="cd-state">正在加载名单…</div>
              ) : filteredRecords.length === 0 ? (
                <div className="cd-state">
                  {!isAdmin
                    ? '没有找到你的名单记录，请联系管理员。'
                    : classRecords.length === 0
                      ? `${selectedClass} 还没有名单，请先导入 .xlsx 文件。`
                      : '没有找到匹配的学生。'}
                </div>
              ) : (
                <div className="cd-table-scroll">
                  <table className="cd-table">
                    <thead>
                      <tr>
                        <th scope="col">姓名</th>
                        <th scope="col">班级</th>
                        <th scope="col">学号</th>
                        <th scope="col">团员</th>
                        <th scope="col">发展情况</th>
                        <th scope="col">
                          {isAdmin ? (
                            <button
                              type="button"
                              className="btn btn-secondary cd-bulk-delete-btn"
                              disabled={deleting}
                              onClick={() => askDelete(filteredRecords)}
                            >
                              <UiIcon name="trash" size={14} />
                              一键删除
                            </button>
                          ) : (
                            <span className="cd-sr-only">操作</span>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecords.map(record => {
                        const member = asNullableBoolean(record.league_member)
                        return (
                          <tr key={record.id}>
                            <td className="cd-name" data-label="姓名">{record.name || '—'}</td>
                            <td data-label="班级">{record.class_name || '—'}</td>
                            <td className="cd-student-id" data-label="学号">{record.student_id || '—'}</td>
                            <td data-label="团员">
                              <span className={`cd-member-pill${member === true ? ' is-member' : member === false ? ' is-non-member' : ' is-unset'}`}>
                                {member === null ? '未填写' : member ? '是' : '否'}
                              </span>
                            </td>
                            <td>
                              <div className="cd-status-list">
                                {member === true ? (
                                  <>
                                    <StatusLine label="入党积极分子" value={record.party_activist} />
                                    <StatusLine label="已推优" value={record.recommended_for_party} />
                                    <StatusLine label="入党申请书" value={record.party_application_submitted} date={record.party_application_date} />
                                  </>
                                ) : member === false ? (
                                  <>
                                    <StatusLine label="入团积极分子" value={record.league_activist} />
                                    <StatusLine label="入团申请书" value={record.league_application_submitted} date={record.league_application_date} />
                                  </>
                                ) : (
                                  <span className="cd-status-unset">先填写团员状态，再维护对应发展信息。</span>
                                )}
                              </div>
                            </td>
                            <td className="cd-row-action" data-label="操作">
                              <div className="cd-row-actions">
                                {isAdmin && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary cd-del-btn"
                                    onClick={() => askDelete([record])}
                                    aria-label={`删除 ${record.name} 的学生信息`}
                                    title="删除该学生信息"
                                  >
                                    <UiIcon name="trash" size={16} />
                                  </button>
                                )}
                                <button type="button" className="btn btn-secondary cd-edit-btn" onClick={() => startEditing(record)}>
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary cd-clear-btn"
                                  disabled={!hasDevelopmentData(record)}
                                  onClick={() => setClearTarget(record)}
                                >
                                  清除数据
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <Modal
        open={!!editing && !!draft}
        title={editing ? `编辑发展信息 · ${editing.name}` : '编辑发展信息'}
        confirmText={saving ? '正在保存…' : '保存修改'}
        cancelText="取消"
        confirmDisabled={saving || !canSave}
        onConfirm={saveRecord}
        onCancel={closeEditor}
      >
        {editing && draft && (
          <div className="cd-edit-form">
            {editError && <p className="cd-edit-error" role="alert">{editError}</p>}
            {!editError && problems.length > 0 && (
              <p className="cd-edit-error" role="alert">
                {problems.length === 1 ? problems[0] : `还有 ${problems.length} 项需要填写：${problems.join('；')}`}
              </p>
            )}
            <div className="cd-edit-student">
              <span>{editing.class_name || '班级未填写'}</span>
              <span>学号 {editing.student_id || '—'}</span>
            </div>
            <BooleanField label="是否团员" name="league_member" value={draft.league_member} onChange={changeDraft} />
            {draft.league_member === true ? (
              <div className="cd-edit-group">
                <h4>入党发展情况</h4>
                <BooleanField label="是否入党积极分子" name="party_activist" value={draft.party_activist} onChange={changeDraft} />
                <BooleanField label="是否推优" name="recommended_for_party" value={draft.recommended_for_party} onChange={changeDraft} />
                <BooleanField label="是否提交入党申请书" name="party_application_submitted" value={draft.party_application_submitted} onChange={changeDraft} />
                {draft.party_application_submitted === true && (
                  <DateField label="入党申请书提交时间" name="party_application_date" value={draft.party_application_date} onChange={changeDraft} />
                )}
              </div>
            ) : draft.league_member === false ? (
              <div className="cd-edit-group">
                <h4>入团发展情况</h4>
                <BooleanField label="是否入团积极分子" name="league_activist" value={draft.league_activist} onChange={changeDraft} />
                <BooleanField label="是否提交入团申请书" name="league_application_submitted" value={draft.league_application_submitted} onChange={changeDraft} />
                {draft.league_application_submitted === true && (
                  <DateField label="入团申请书提交时间" name="league_application_date" value={draft.league_application_date} onChange={changeDraft} />
                )}
              </div>
            ) : (
              <p className="cd-edit-unset">请先填写团员状态，再维护对应的发展情况。</p>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={!!clearTarget}
        danger
        title={clearTarget ? `清除发展信息 · ${clearTarget.name}` : '清除发展信息'}
        message={clearTarget
          ? `将清空 ${clearTarget.name}（${clearTarget.class_name || '班级未填写'} · 学号 ${clearTarget.student_id}）的全部团员与发展信息，恢复为“未填写”，且不可撤销。`
          : ''}
        confirmText={clearing ? '正在清除…' : '确认清除'}
        cancelText="取消"
        confirmDisabled={clearing}
        onConfirm={clearRecord}
        onCancel={() => { if (!clearing) setClearTarget(null) }}
      />

      <Modal
        open={!!pendingDelete}
        danger
        title={pendingDelete ? pendingDelete.title : '删除学生信息'}
        message={pendingDelete ? pendingDelete.message : ''}
        confirmText={deleting ? '正在删除…' : '确认删除'}
        cancelText="取消"
        confirmDisabled={deleting}
        onConfirm={deleteRecords}
        onCancel={() => { if (!deleting) setPendingDelete(null) }}
      />

      {/* 页面级提示：悬浮在页面上方，3 秒后自动消失，右侧 × 可手动关闭 */}
      {toast && (
        <div
          className={`cd-toast cd-toast-${toast.type}`}
          role={toast.type === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <UiIcon name={toast.type === 'error' ? 'alert' : 'check'} size={16} className="cd-toast-icon" />
          <span className="cd-toast-text">{toast.text}</span>
          <button type="button" className="cd-toast-close" onClick={dismissToast} aria-label="关闭提示">
            <UiIcon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
