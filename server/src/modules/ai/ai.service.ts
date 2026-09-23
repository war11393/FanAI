import { Injectable } from '@nestjs/common';
import { IncomingHttpHeaders } from 'http';

/**
 * AI 服务抽象层（Adapter Pattern + Provider 多实现）
 *
 * PRD 要求：定义一个统一接口层（recognizeImage / recognizeVoice / generateRecipes），
 * 内部默认实现调用大模型，方便无缝切换其他模型。
 *
 * 本文件通过环境变量 AI_PROVIDER 选择底层模型提供方（Provider）：
 *
 *   1. "http"（默认）  —— 通过 HTTP 调用任何 OpenAI 兼容接口
 *                         （配 AI_HTTP_BASE_URL / AI_HTTP_API_KEY / AI_HTTP_MODEL）。
 *                         例如 DeepSeek、通义千问（DashScope 兼容模式）、Kimi、
 *                         智谱 GLM、OpenAI 等均可。
 *   2. "wechat"        —— 微信云开发桥接：转发到你在微信云开发部署的云函数
 *                         HTTP 触发器（配 AI_WECHAT_URL / AI_WECHAT_TOKEN，
 *                         云函数骨架见仓库根目录 cloudfunctions/ai-service）。
 *
 * 两种 Provider 对外暴露的能力一致：文本生成（generateJson）、视觉识别（analyzeImage）。
 * 无论切换哪个 Provider，上层 controller 与前端调用方式完全不变。
 */
@Injectable()
export class AiService {
  /* ============ Provider 选择 ============ */

  private get provider(): 'http' | 'wechat' {
    const p = (process.env.AI_PROVIDER || 'http').toLowerCase();
    return p === 'wechat' ? 'wechat' : 'http';
  }

  private wechatUrl(): string | undefined {
    return process.env.AI_WECHAT_URL;
  }
  private wechatToken(): string | undefined {
    return process.env.AI_WECHAT_TOKEN;
  }

  /* ============ 统一对外能力 ============ */

  /**
   * 调用大模型并强制返回纯 JSON。内容失败时返回 null，由调用方兜底。
   */
  async generateJson(systemPrompt: string, userPrompt: string, opts?: { model?: string; temperature?: number }, headers?: IncomingHttpHeaders): Promise<unknown | null> {
    try {
      const text = await this.chatOnce(systemPrompt, userPrompt, 'text', opts);
      return this.safeParseJson(text);
    } catch (e) {
      console.error('[ai] generateJson error', this.provider, (e as Error).message);
      return null;
    }
  }

  /** 视觉识别：传入公开图片 URL */
  async analyzeImage(imageUrl: string, userPrompt: string, headers?: IncomingHttpHeaders): Promise<unknown | null> {
    try {
      const text = await this.chatOnce('', userPrompt, 'image', { imageUrl });
      return this.safeParseJson(text);
    } catch (e) {
      console.error('[ai][vision] error', this.provider, (e as Error).message);
      return null;
    }
  }

  /* ============ 底层调用分发 ============ */

  private async chatOnce(
    systemPrompt: string,
    userContent: string,
    kind: 'text' | 'image',
    opts?: { model?: string; temperature?: number; imageUrl?: string },
  ): Promise<string> {
    switch (this.provider) {
      case 'wechat':
        return this.wechatChat(systemPrompt, userContent, kind, opts);
      case 'http':
      default:
        return this.httpChat(systemPrompt, userContent, kind, opts);
    }
  }

  /** Provider 1：OpenAI 兼容 HTTP 接口 */
  private async httpChat(
    systemPrompt: string,
    userContent: string,
    kind: 'text' | 'image',
    opts?: { model?: string; temperature?: number; imageUrl?: string },
  ): Promise<string> {
    const baseUrl = (process.env.AI_HTTP_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const apiKey = process.env.AI_HTTP_API_KEY || '';
    if (!apiKey) {
      throw new Error('AI_HTTP_API_KEY 未配置（请在 server/.env 中设置）');
    }
    const model = opts?.model
      ?? (kind === 'image' ? process.env.AI_HTTP_VISION_MODEL : undefined)
      ?? process.env.AI_HTTP_MODEL ?? 'gpt-4o-mini';
    const messages: Array<{ role: string; content: any }> = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (kind === 'image' && opts?.imageUrl) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: userContent },
          { type: 'image_url', image_url: { url: opts.imageUrl } },
        ],
      });
    } else {
      messages.push({ role: 'user', content: userContent });
    }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts?.temperature ?? 0.6,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP provider status ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as any;
    return json?.choices?.[0]?.message?.content ?? '';
  }

  /** Provider 2（微信云开发桥接）：转发到云函数 HTTP 触发器 */
  private async wechatChat(
    systemPrompt: string,
    userContent: string,
    kind: 'text' | 'image',
    opts?: { model?: string; temperature?: number; imageUrl?: string },
  ): Promise<string> {
    const url = this.wechatUrl();
    if (!url) throw new Error('AI_WECHAT_URL 未配置');
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.wechatToken() ? { Authorization: `Bearer ${this.wechatToken()}` } : {}),
      },
      body: JSON.stringify({
        kind,
        systemPrompt,
        userContent,
        imageUrl: opts?.imageUrl,
        model: opts?.model,
        temperature: opts?.temperature,
      }),
    });
    if (!resp.ok) {
      throw new Error(`wechat provider status ${resp.status}: ${await resp.text()}`);
    }
    const json = (await resp.json()) as any;
    // 云函数返回 { code:200, data: { content } } 或 { content }
    const data = json?.data ?? json;
    const content = typeof data === 'string' ? data : data?.content ?? data?.text ?? '';
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('wechat provider 未返回内容');
    }
    return content;
  }

  /* ============ 工具 ============ */

  /** 健壮解析 JSON（剥离 markdown 代码围栏等） */
  private safeParseJson(text: string): unknown | null {
    if (!text) return null;
    const trimmed = text.trim();
    // 剥离 ```json ... ```
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试截取第一个 { 到最后一个 }
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}
