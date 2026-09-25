/**
 * 云开发调用封装层
 * ---------------------------------------------------------------
 * 取代原 Network.request / Network.uploadFile（HTTP -> HTTP 云函数）。
 *
 * 【为什么需要这层】
 *   1. 统一解包云函数信封 { success, code, message, data }
 *   2. 统一错误处理与 Toast 提示
 *   3. 非微信端（H5/抖音）降级：云开发不可用时抛出明确错误，
 *      便于上层做只读降级或提示用户去小程序端使用
 *
 * 【安全模型】★
 *   openid 不再由前端传入，改由云函数从 getWXContext() 取真实值。
 *   因此本层所有调用都不需要（也不应该）传 openid。
 */

import Taro from '@tarojs/taro';
import { CLOUD_ENV_ID } from './config';

/** 云函数返回的标准信封 */
export interface CloudEnvelope<T = unknown> {
  success: boolean;
  code: number | string;
  message: string;
  data: T;
}

/** 云函数调用失败时抛出的错误 */
export class CloudError extends Error {
  code: number | string;
  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

/** 当前是否处于微信小程序端（云开发唯一可用的端） */
export const isCloudAvailable = (): boolean =>
  Taro.getEnv() === Taro.ENV_TYPE.WEAPP;

let inited = false;

/** 初始化云开发环境（幂等，App 启动时调用一次即可） */
export function initCloud(): void {
  if (inited) return;
  if (!isCloudAvailable()) return;

  // Taro.cloud 对应 wx.cloud
  const cloud = (Taro as any).cloud;
  if (!cloud) {
    console.error('[cloud] 当前 Taro 版本不支持 Taro.cloud，请检查编译配置');
    return;
  }
  cloud.init({
    env: CLOUD_ENV_ID,
    traceUser: true,
  });
  inited = true;
}

/**
 * 调用云函数并解包信封
 * @param name 云函数名
 * @param data 入参（含 action）
 * @param options 可选：是否静默（不弹 Toast）
 */
export async function callCloud<T = unknown>(
  name: string,
  data: Record<string, unknown> = {},
  options: { silent?: boolean } = {},
): Promise<T> {
  if (!isCloudAvailable()) {
    const err = new CloudError(
      'CLOUD_UNAVAILABLE',
      '云开发能力仅在小程序端可用，请使用微信小程序打开',
    );
    if (!options.silent) {
      Taro.showToast({ title: '请在小程序端使用', icon: 'none' });
    }
    throw err;
  }

  initCloud();

  let res: any;
  try {
    res = await (Taro as any).cloud.callFunction({ name, data });
  } catch (e) {
    const msg = (e as Error)?.message || '网络异常';
    console.error(`[cloud] callFunction(${name}) 网络失败:`, msg);
    if (!options.silent) {
      Taro.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    throw new CloudError('NETWORK_ERROR', msg);
  }

  const envelope = res?.result as CloudEnvelope<T> | undefined;

  // 云函数未按约定返回信封（例如部署了旧版本）
  if (!envelope || typeof envelope !== 'object' || !('success' in envelope)) {
    console.error(`[cloud] callFunction(${name}) 返回结构异常:`, res?.result);
    if (!options.silent) {
      Taro.showToast({ title: '服务返回异常', icon: 'none' });
    }
    throw new CloudError('BAD_RESPONSE', '云函数返回结构异常');
  }

  if (!envelope.success) {
    console.error(
      `[cloud] callFunction(${name}) 业务失败: ${envelope.code} ${envelope.message}`,
    );
    if (!options.silent) {
      Taro.showToast({ title: envelope.message || '操作失败', icon: 'none' });
    }
    throw new CloudError(envelope.code, envelope.message);
  }

  return envelope.data;
}

/**
 * 把本地图片读成 base64 data URL
 * ★ F2 决策：图片不落云存储，直接 base64 传给视觉模型，调用后即销毁。
 *   微信端用 getFileSystemManager().readFile({ encoding:'base64' })；
 *   H5 端降级用 FileReader。
 *
 * ★ 体积控制：相机原图常有 3-8MB，base64 后还要膨胀 ~33%，会超出云函数
 *   入参上限。故先交给平台压缩再读（compressImage 可显著降低体积）。
 */
export async function readImageAsDataUrl(filePath: string): Promise<string> {
  if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
    // 先压缩：质量 80、限制最长边 1280，够模型识别又不会过大
    let target = filePath;
    try {
      const compressed = await new Promise<string>((resolve) => {
        Taro.compressImage({
          src: filePath,
          quality: 80,
          compressedWidth: 1280,
          success: (r) => resolve(r.tempFilePath || filePath),
          fail: () => resolve(filePath), // 压缩失败就用原图，不阻断流程
        });
      });
      target = compressed;
    } catch {
      /* 忽略，用原图 */
    }

    const fs = Taro.getFileSystemManager();
    const base64 = await new Promise<string>((resolve, reject) => {
      fs.readFile({
        filePath: target,
        encoding: 'base64',
        success: (r) => resolve(r.data as string),
        fail: (e) => reject(new Error(e?.errMsg || '读取图片失败')),
      });
    });
    // 小程序 chooseImage 多为 jpg；png 也走同一分支，模型能自行判断
    return `data:image/jpeg;base64,${base64}`;
  }
  // H5 降级
  const resp = await fetch(filePath);
  const blob = await resp.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 上传文件到云存储
 * @returns fileID（云存储永久标识）
 */
export async function uploadToCloudStorage(
  filePath: string,
  cloudPath: string,
): Promise<string> {
  if (!isCloudAvailable()) {
    throw new CloudError('CLOUD_UNAVAILABLE', '云存储仅在小程序端可用');
  }
  initCloud();

  try {
    const res = await (Taro as any).cloud.uploadFile({ cloudPath, filePath });
    if (!res?.fileID) {
      throw new Error('上传未返回 fileID');
    }
    return res.fileID as string;
  } catch (e) {
    console.error('[cloud] uploadFile 失败:', (e as Error)?.message);
    Taro.showToast({ title: '上传失败，请重试', icon: 'none' });
    throw new CloudError('UPLOAD_FAILED', (e as Error)?.message || '上传失败');
  }
}

/**
 * 把云存储 fileID 换成可访问的临时 URL
 * ★ 用于展示图片；vision 模型也接受 fileID，但展示必须换 URL
 */
export async function getTempFileURL(fileID: string): Promise<string> {
  if (!fileID) return '';
  // 已经是 http(s) 的直接返回（例如生图转存失败时的临时 URL）
  if (/^https?:\/\//.test(fileID)) return fileID;
  if (!isCloudAvailable()) return fileID;
  initCloud();
  try {
    const res = await (Taro as any).cloud.getTempFileURL({ fileList: [fileID] });
    return res?.fileList?.[0]?.tempFileURL || '';
  } catch (e) {
    console.error('[cloud] getTempFileURL 失败:', (e as Error)?.message);
    return '';
  }
}

/** 生成云存储路径：食材照片 */
export const buildIngredientPhotoPath = (ext = 'jpg'): string =>
  `ingredient-photos/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
