/**
 * Azure AI Foundry chat-completions adapter.
 *
 * Mirrors the surface of `callClaude` (in AIService.ts) so the router
 * can drop Foundry in as a backend without callers caring which model
 * answered. Uses the OpenAI-compatible chat-completions schema that
 * Foundry serverless deployments expose by default — same JSON shape
 * GPT / Llama-on-Azure / Phi all accept.
 *
 * Environment variables (set on the backend Container App):
 *
 *   AZURE_AI_ENDPOINT      — full endpoint URL up to /chat/completions
 *                            of the deployed model. e.g.:
 *                              https://my-foundry.eastus.models.ai.azure.com/v1/chat/completions
 *                              https://my-foundry.eastus.inference.ai.azure.com/v1/chat/completions
 *                            (Foundry shows you the exact URL on the
 *                             deployment's "Endpoint" tab.)
 *   AZURE_AI_API_KEY       — API key from the same tab.
 *   AZURE_AI_DEPLOYMENT    — model name to send in the request body.
 *                            For serverless deployments this is the
 *                            deployed model id (e.g. "Meta-Llama-3.3-70B-Instruct").
 *
 * If any of those are missing, `isAzureConfigured()` returns false and
 * the router silently routes back to Claude — the toggle UI surfaces
 * this so admins know why "Azure Full" isn't taking effect.
 *
 * Failures fall back to Claude (router decision, not this adapter's
 * concern). We just throw; the router catches.
 */

import { logger } from '../../utils/logger';

const log = logger.child({ component: 'azure-ai' });

export interface AzureChatOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AzureChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** True when the env is configured with everything the adapter needs. */
export function isAzureConfigured(): boolean {
  return !!(
    process.env.AZURE_AI_ENDPOINT &&
    process.env.AZURE_AI_API_KEY &&
    process.env.AZURE_AI_DEPLOYMENT
  );
}

/**
 * Issue one chat-completion call to Foundry. Returns the assistant
 * text and the token counts (for budget tracking + telemetry parity
 * with the Claude path).
 *
 * Throws on:
 *   - missing config (caller should have checked isAzureConfigured)
 *   - non-2xx HTTP response (with body for diagnosis)
 *   - malformed response payload
 */
export async function callAzureChat(opts: AzureChatOptions): Promise<AzureChatResult> {
  const endpoint = process.env.AZURE_AI_ENDPOINT;
  const apiKey   = process.env.AZURE_AI_API_KEY;
  const model    = process.env.AZURE_AI_DEPLOYMENT;
  if (!endpoint || !apiKey || !model) {
    throw new Error('Azure AI not configured (AZURE_AI_ENDPOINT, AZURE_AI_API_KEY, AZURE_AI_DEPLOYMENT)');
  }

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
        // Foundry serverless accepts both `Authorization: Bearer …` and
        // `api-key: …`. We send api-key; switch if your deployment
        // rejects (verify on the endpoint page).
        'api-key':       apiKey,
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, durationMs: Date.now() - start }, 'azure call network error');
    throw new Error(`Azure AI network error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn({ status: res.status, body: text.slice(0, 400), durationMs: Date.now() - start }, 'azure call failed');
    throw new Error(`Azure AI ${res.status}: ${text.slice(0, 200)}`);
  }

  // Expected shape (OpenAI-compatible):
  //   { choices: [{ message: { content: "..." } }],
  //     usage: { prompt_tokens, completion_tokens, total_tokens } }
  type AzureResp = {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const json = await res.json() as AzureResp;
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('Azure AI: unexpected response shape (no choices[0].message.content)');
  }

  return {
    text,
    inputTokens:  json.usage?.prompt_tokens     ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}
