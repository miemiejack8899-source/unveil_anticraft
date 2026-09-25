import { Navigate } from 'react-router-dom'
import AuthPage from './pages/AuthPage'
import IdentityPage from './pages/IdentityPage'
import ToolHomePage from './pages/ToolHomePage'

// 基础路由（功能路由由 src/features/<name>/routes.jsx 自动挂载）
// 进站先做身份检测：/ 与 /identity 都是检测页，检测通过后才进入功能页
export default [
  { path: '/', element: <IdentityPage /> },
  { path: '/identity', element: <IdentityPage /> },
  { path: '/auth', element: <AuthPage /> },
  { path: '/login', element: <Navigate to="/auth" replace /> },
  { path: '/tools', element: <ToolHomePage /> },
]
