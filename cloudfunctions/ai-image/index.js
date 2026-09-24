/**
 * 云函数：ai-image —— 文生图（腾讯混元 HY-Image-3.0-Plus-4090-Tob-v1.0）
 * ---------------------------------------------------------------
 * 【模型】HY-Image-3.0-Plus-4090-Tob-v1.0
 *         ★ 生图只能服务端调用，必须用 @cloudbase/node-sdk >= 3.18.3
 *         （wx-server-sdk 的 cloud.ai() 不支持生图）
 *
 * 【关键约束】
 *   1. 生成结果 URL 仅 24 小时有效 -> 必须立即转存云存储拿永久 fileID
 *   2. 云函数超时建议设 900 秒（生图 10~30s，revise +10s，thinking 最多 +60s）
 *   3. prompt 最长 500 字
 *   4. 支持尺寸：1024x1024(默认) / 1280x720 / 720x1280 / 1280x1280
 *
 * 【用法】action: 'generate'
 *   { action:'generate', prompt:'西红柿炒鸡蛋 成品图', size:'1024x1024',
 *     revise: true, enableThinking: false, recipeName: '西红柿炒鸡蛋' }
 *   返回 { fileID, tempUrl, revisedPrompt, model }
 *
 * 【用途场景】本项目里主要用于「菜谱成品图」生成
 */

const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { wrap, ok, requireFields, BizError } = require('./common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, timeout: 900000 });

/** 支持的尺寸白名单 */
const ALLOWED_SIZES = ['1024x1024', '1280x720', '720x1280', '1280x1280'];
const DEFAULT_SIZE = '1024x1024';
const MODEL = 'HY-Image-3.0-Plus-4090-Tob-v1.0';
const MAX_PROMPT_LEN = 500;

/** 云存储中的图片目录 */
const STORAGE_DIR = 'recipe-images';

/**
 * 用 https 把临时 URL 的图片下载为 Buffer
 * ★ 官方推荐在云函数内立即转存，避免 24 小时后 URL 失效
 */
function downloadImage(url) {
  const https = require('https');
  const http = require('http');
  const lib = url.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    lib
      .get(url, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadImage(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载图片失败，状态码 ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** 转存到云存储，返回 fileID */
async function saveToStorage(buffer, fileName) {
  const res = await cloud.uploadFile({
    cloudPath: `${STORAGE_DIR}/${fileName}`,
    fileContent: buffer,
  });
  return res.fileID;
}

/** 生成图片文件名 */
function buildFileName(recipeName) {
  const safe = String(recipeName || 'dish').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
  return `${safe}_${Date.now()}.png`;
}

/** 把外部图片 URL 转成云存储 fileID */
async function mirrorToStorage(tempUrl, recipeName) {
  const buffer = await downloadImage(tempUrl);
  return saveToStorage(buffer, buildFileName(recipeName));
}

exports.main = wrap(async (event) => {
  requireFields(event, ['prompt']);

  let prompt = String(event.prompt).trim();
  if (prompt.length > MAX_PROMPT_LEN) {
    prompt = prompt.slice(0, MAX_PROMPT_LEN);
  }

  let size = event.size || DEFAULT_SIZE;
  if (!ALLOWED_SIZES.includes(size)) {
    size = DEFAULT_SIZE;
  }

  const revise = event.revise !== false; // 默认开启提示词优化，出图质量更好
  const enableThinking = event.enableThinking === true;

  const app = cloudbase.init({ env: process.env.ENV_ID || cloud.DYNAMIC_CURRENT_ENV });
  const ai = app.ai();
  const imageModel = ai.createImageModel('hunyuan-image');

  let result;
  try {
    result = await imageModel.generateImage({
      model: MODEL,
      prompt,
      size,
      revise: { value: revise },
      ...(enableThinking ? { enable_thinking: { value: true } } : {}),
    });
  } catch (e) {
    console.error('[ai-image] generateImage error:', e && e.message);
    throw new BizError('IMAGE_GEN_FAILED', `图片生成失败: ${(e && e.message) || '未知错误'}`, 500);
  }

  const first = result && result.data && result.data[0];
  const tempUrl = first && first.url;
  const revisedPrompt = (first && first.revised_prompt) || prompt;
  if (!tempUrl) {
    throw new BizError('IMAGE_GEN_FAILED', '模型未返回图片 URL', 500);
  }

  // ★ 立即转存云存储，拿永久 fileID（临时 URL 24h 后失效）
  let fileID = '';
  let mirrorError = null;
  try {
    fileID = await mirrorToStorage(tempUrl, event.recipeName || prompt);
  } catch (e) {
    // 转存失败不阻断主流程，把临时 URL 返回给前端并标记
    mirrorError = (e && e.message) || '转存失败';
    console.error('[ai-image] mirror to storage failed:', mirrorError);
  }

  return ok({
    fileID: fileID || null,
    tempUrl,            // 24 小时有效，转存失败时的降级展示
    tempUrlExpiresIn: 86400,
    revisedPrompt,
    model: MODEL,
    size,
    mirrored: !!fileID,
    mirrorError,
  });
});
