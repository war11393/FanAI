import { createClient, SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

let envLoaded = false;

interface SupabaseCredentials {
  url: string;
  anonKey: string;
}

/**
 * 加载环境变量：
 * 1. 优先使用进程环境中已有的 SUPABASE_URL / SUPABASE_ANON_KEY；
 * 2. 其次读取 server/.env（本地部署时的配置文件）；
 * 3. 兼容读取项目根目录 .env.local。
 */
function loadEnv(): void {
  if (envLoaded || (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)) {
    envLoaded = true;
    return;
  }

  const candidates = [
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../../.env'),
    path.resolve(__dirname, '../../../..', '.env.local'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // 文件不可读时跳过
    }
  }

  envLoaded = true;
}

function getSupabaseCredentials(): SupabaseCredentials {
  loadEnv();

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('SUPABASE_URL is not set（请在 server/.env 中配置）');
  }
  if (!anonKey) {
    throw new Error('SUPABASE_ANON_KEY is not set（请在 server/.env 中配置）');
  }

  return { url, anonKey };
}

function getSupabaseServiceRoleKey(): string | undefined {
  loadEnv();
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function getSupabaseClient(token?: string): SupabaseClient {
  const { url, anonKey } = getSupabaseCredentials();

  let key: string;
  if (token) {
    key = anonKey;
  } else {
    const serviceRoleKey = getSupabaseServiceRoleKey();
    key = serviceRoleKey ?? anonKey;
  }

  const globalOptions: Record<string, any> = {};
  if (token) {
    globalOptions.headers = { Authorization: `Bearer ${token}` };
  }

  return createClient(url, key, {
    global: globalOptions,
    db: {
      timeout: 60000,
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { loadEnv, getSupabaseCredentials, getSupabaseServiceRoleKey, getSupabaseClient };
