/**
 * Azure AI adapters — two backends, one interface.
 *
 * 1. **Azure AI Foundry** (serverless deployments):
 *    Single model per endpoint. Llama, Phi, Mistral, DeepSeek, etc.
 *    Env: AZURE_AI_ENDPOINT, AZURE_AI_API_KEY, AZURE_AI_DEPLOYMENT
 *
 * 2. **Azure OpenAI Service** (managed OpenAI models):
 *    Multiple deployments per resource. GPT-4o, GPT-4o-mini, GPT-4.1, etc.
 *    Env: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_API_VERSION
 *
 * Both use the OpenAI-compatible chat-completions JSON shape. The
 * difference is in the endpoint URL format and auth header.
 *
 * Failures throw — the router catches and falls back to Claude.
 */

import { logger } from '../../utils/logger';

const log = logger.child({ component: 'azure-ai' });

export interface AzureChatOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AzureOpenAIChatOptions extends AzureChatOptions {
  deploymentName: string;
}

export interface AzureChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

// ─── Azure AI Foundry ─────────────────────────────────────────────────────

export function isAzureConfigured(): boolean {
  return !!(
    process.env.AZURE_AI_ENDPOINT &&
    process.env.AZURE_AI_API_KEY &&
    process.env.AZURE_AI_DEPLOYMENT
  );
}

export async function callAzureChat(opts: AzureChatOptions): Promise<AzureChatResult> {
  const endpoint = process.env.AZURE_AI_ENDPOINT;
  const apiKey   = process.env.AZURE_AI_API_KEY;
  const model    = process.env.AZURE_AI_DEPLOYMENT;
  if (!endpoint || !apiKey || !model) {
    throw new Error('Azure AI Foundry not configured (AZURE_AI_ENDPOINT, AZURE_AI_API_KEY, AZURE_AI_DEPLOYMENT)');
  }

  return doOpenAICompatibleCall(endpoint, apiKey, model, opts);
}

// ─── Azure OpenAI Service ─────────────────────────────────────────────────

export function isAzureOpenAIConfigured(): boolean {
  return !!(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_API_KEY
  );
}

export function getAzureOpenAIDeployments(): string[] {
  const raw = process.env.AZURE_OPENAI_DEPLOYMENTS ?? '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export async function callAzureOpenAIChat(opts: AzureOpenAIChatOptions): Promise<AzureChatResult> {
  const baseEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
  const apiKey       = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion   = process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview';
  if (!baseEndpoint || !apiKey) {
    throw new Error('Azure OpenAI not configured (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY)');
  }

  const endpoint = `${baseEndpoint}/openai/deployments/${encodeURIComponent(opts.deploymentName)}/chat/completions?api-version=${apiVersion}`;
  return doOpenAICompatibleCall(endpoint, apiKey, opts.deploymentName, opts);
}

// ─── Shared OpenAI-compatible call ────────────────────────────────────────

async function doOpenAICompatibleCall(
  endpoint: string,
  apiKey: string,
  model: string,
  opts: AzureChatOptions,
): Promise<AzureChatResult> {
  const body = {
    model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user',   content: opts.userPrompt },
    ],
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'api-key':       apiKey,
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, model, durationMs: Date.now() - start }, 'azure call network error');
    throw new Error(`Azure AI network error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn({ status: res.status, model, body: text.slice(0, 400), durationMs: Date.now() - start }, 'azure call failed');
    throw new Error(`Azure AI ${res.status}: ${text.slice(0, 200)}`);
  }

  type AzureResp = {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const json = await res.json() as AzureResp;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('Azure AI: unexpected response shape (no choices[0].message.content)');
  }

  log.debug({ model, durationMs: Date.now() - start, inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens }, 'azure call OK');

  return {
    text,
    inputTokens:  json.usage?.prompt_tokens     ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}
