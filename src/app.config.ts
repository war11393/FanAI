export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/fridge/index',
    'pages/recipes/index',
    'pages/profile/index',
    'pages/cook/index'
  ],
  // 微信云开发大模型 / 同声传译等官方插件预留位：
  // 在微信公众平台开通插件后，填入真实 AppID 即可启用语音识别与 TTS 能力。
  // 例：plugins: { 'WechatSI': { version: '0.3.6', provider: 'wx069ba97219f66d99' } }
  // 注意：未开通前请勿填写，否则编译期会因找不到 AppID 报错。
  plugins: {},
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#FFF3E0',
    navigationBarTitleText: '今天吃什么',
    navigationBarTextStyle: 'black',
    backgroundColor: '#FFF3E0'
  },
  tabBar: {
    color: '#999999',
    selectedColor: '#FF8C42',
    backgroundColor: '#FFFFFF',
    borderStyle: 'black',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '首页',
        iconPath: './assets/tabbar/house.png',
        selectedIconPath: './assets/tabbar/house-active.png'
      },
      {
        pagePath: 'pages/fridge/index',
        text: '冰箱',
        iconPath: './assets/tabbar/refrigerator.png',
        selectedIconPath: './assets/tabbar/refrigerator-active.png'
      },
      {
        pagePath: 'pages/recipes/index',
        text: '菜谱',
        iconPath: './assets/tabbar/book-open.png',
        selectedIconPath: './assets/tabbar/book-open-active.png'
      },
      {
        pagePath: 'pages/profile/index',
        text: '我的',
        iconPath: './assets/tabbar/user.png',
        selectedIconPath: './assets/tabbar/user-active.png'
      }
    ]
  }
})