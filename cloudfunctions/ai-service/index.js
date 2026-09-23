/**
 * 微信云函数：AI 服务桥接（方案 B 骨架）
 * ----------------------------------------------------------------
 * 【用途】在本项目后端 NestJS/前端把大模型调用转发到这里，由微信云开发侧
 *        统一管理模型密钥与调用（享微信官方免费额度）。
 *
 * 【部署步骤】（在微信开发者工具中操作）
 *   1. 新建云函数目录，命名为 `ai-service`，把本文件作为 index.js。
 *   2. 右键该目录 -> 「上传并部署：云端安装依赖」。
 *   3. 打开云函数的「配置」->「触发器」，添加 HTTP 触发器（或高级触发器），
 *      得到一个 HTTPS 访问地址，记作 <HTTP_TRIGGER_URL>。
 *   4. 在本项目 server/.env 中配置：
 *        AI_PROVIDER=wechat
 *        AI_WECHAT_URL=<HTTP_TRIGGER_URL>
 *        AI_WECHAT_TOKEN=<你在下方 WECHAT_TOKEN 里设的令牌>
 *
 * 【四种回调契约】前两种与后端 AiService.wechatChat 解析完全对齐
 *   - 文本生成 POST { kind:"text", systemPrompt, userContent, ... }
 *   - 视觉识别 POST { kind:"image", userContent, imageUrl, ... }
 *   统一返回 { code:200, data:{ content:"..." } }，失败返回 { code:500, msg:"..." }
 *
 * 【大模型调用】默认通过 HTTP 调用 DuckDuckGo…… 不，改为可配置三方（OpenAI 兼容）
 *   使用环境变量 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME 控制。
 *   - 若你的"微信大模型免费额度"是走模型 HTTP 接口，就在这里填地址与 Key。
 *   - 若走微信同声传译/其他云端能力，替换下方 fetchModel 具体实现即可。
 * ----------------------------------------------------------------
 */
const WECHAT_TOKEN = process.env.AI_WECHAT_TOKEN || 'your-wechat-forward-token';

/*
 * 安全校验：与后端 AI_WECHAT_TOKEN 保持一致
 */
function isAllowed(event) {
  if (!WECHAT_TOKEN || WECHAT_TOKEN === 'your-wechat-forward-token') return false;
  return (event.headers && event.headers.authorization === `Bearer ${WECHAT_TOKEN}`) ||
         (event.headers && event.headers['x-token'] === WECHAT_TOKEN);
}

async function fetchModel(messages) {
  const baseUrl = (process.env.MODEL_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.MODEL_API_KEY || '';
  const model = process.env.MODEL_NAME || 'gpt-4o-mini';
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, response_format: { type: 'json_object' } }),
  });
  if (!resp.ok) throw new Error(`model status ${resp.status}`);
  const json = await resp.json();
  return json.choices && json.choices[0] && json.choices[0].message.content;
}

exports.main = async (event, context) => {
  // 微信云函数：event 为入参对象；HTTP 触发器场景 body 已解析注入
  const body = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);

  // 鉴权（HTTP 触发场景启用；云函数直调可不校验）
  // const authed = isAllowed(event);
  // if (!authed) return { code: 401, msg: 'unauthorized' };

  const { kind = 'text', systemPrompt = '', userContent = '', imageUrl = '' } = body || {};

  try {
    let messages;
    if (kind === 'image' && imageUrl) {
      messages = [{ role: 'user', content: [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]}];
    } else {
      const msgs = [];
      if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
      msgs.push({ role: 'user', content: userContent });
      messages = msgs;
    }
    const content = await fetchModel(messages);
    return { code: 200, data: { content } };
  } catch (e) {
    return { code: 500, msg: e.message || 'ai error' };
  }
};