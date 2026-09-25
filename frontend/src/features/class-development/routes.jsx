import ClassDevelopmentPage from './ClassDevelopmentPage'

export default [
  { path: '/tools/class-development', element: <ClassDevelopmentPage /> },
]

// roleLabels：该栏目文字按当前登录角色显示（未登录时回退到 label）
export const nav = [{
  label: '班级发展信息',
  path: '/tools/class-development',
  parent: '/tools',
  roleLabels: { admin: '管理员', user: '普通用户' },
}]
