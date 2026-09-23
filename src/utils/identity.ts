import Taro from '@tarojs/taro';

const OPENID_KEY = 'cook_openid';

/**
 * 微信云开发会自动注入 _openid；本环境用本地持久化设备 ID 充当用户唯一标识。
 * 不同用户天然隔离数据，符合"按用户隔离"的模型设计。
 */
export function getOpenid(): string {
  let openid = Taro.getStorageSync(OPENID_KEY);
  if (!openid) {
    // 生成一个 32 位随机 ID
    const s: string[] = [];
    for (let i = 0; i < 32; i++) {
      s.push(((Math.random() * 16) | 0).toString(16));
    }
    openid = 'dev_' + s.join('');
    Taro.setStorageSync(OPENID_KEY, openid);
  }
  return openid;
}