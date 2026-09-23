export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '我的冰箱' })
  : { navigationBarTitleText: '我的冰箱' }