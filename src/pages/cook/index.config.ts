export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '做饭' })
  : { navigationBarTitleText: '做饭' }