import { Link } from 'react-router-dom'
import Navbar from '../components/Navbar'
import { UiIcon } from '../components/Icons'
import { t } from '../i18n'
import './ToolHomePage.css'

function ToolHomePage() {
  return (
    <div className="tool-page">
      <Navbar activePage="tools" />
      <div className="tool-main">
        <header className="tool-header">
          <h1 className="tool-title">{t('toolHome.title')}</h1>
          <p className="tool-subtitle">{t('toolHome.subtitle')}</p>
        </header>

        <div className="tool-cards">
          <Link to="/tools/class-development" className="tool-card-link">
            <div className="tool-card-icon"><UiIcon name="campus" size={28} className="tool-brand-icon" /></div>
            <div className="tool-card-info">
              <h2 className="tool-card-name">班级发展信息</h2>
              <p className="tool-card-desc">全班同学的团员与入党发展情况收集与维护</p>
            </div>
            <span className="tool-card-arrow">→</span>
          </Link>
        </div>
      </div>
    </div>
  )
}

export default ToolHomePage
