export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '我的菜谱' })
  : { navigationBarTitleText: '我的菜谱' }