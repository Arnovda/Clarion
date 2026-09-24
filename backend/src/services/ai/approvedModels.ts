/**
 * Which (provider, model) pairs a tenant admin may pick per AI category.
 *
 * Anthropic: the reviewed list in ai/modelCapabilities.ts.
 * Azure: only what THIS deployment is configured to reach. An Azure
 * OpenAI deployment exists only if it is named in AZURE_OPENAI_DEPLOYMENTS;
 * the Foundry deployment is AZURE_AI_DEPLOYMENT. Offering a guessed name
 * (the old list offered gpt-4o etc. whenever the endpoint was set) lets an
 * admin save a model the endpoint does not have, and every call then
 * fails over to Claude with a warning nobody reads.
 *
 * The same list is shown by GET /admin/ai-routing, enforced by
 * PUT /admin/ai-routing/categories/:category, and re-checked when a call
 * resolves its model, so a model removed later stops being used at once.
 */

import { APPROVED_ANTHROPIC_MODELS, isApprovedAnthropicModel } from '../../ai/modelCapabilities';
import { isAzureConfigured, isAzureOpenAIConfigured, getAzureOpenAIDeployments } from './azureClient';

export type ModelProvider = 'anthropic' | 'azure-openai' | 'azure-foundry';

export interface ApprovedModel {
  provider: ModelProvider;
  model_id: string;
  label: string;
}

export function approvedModels(): ApprovedModel[] {
  const out: ApprovedModel[] = APPROVED_ANTHROPIC_MODELS.map((m) => ({
    provider: 'anthropic' as const, model_id: m.id, label: m.label,
  }));
  if (isAzureOpenAIConfigured()) {
    for (const d of getAzureOpenAIDeployments()) {
      out.push({ provider: 'azure-openai', model_id: d, label: `Azure OpenAI: ${d}` });
    }
  }
  if (isAzureConfigured()) {
    const d = process.env.AZURE_AI_DEPLOYMENT as string;
    out.push({ provider: 'azure-foundry', model_id: d, label: `Azure Foundry: ${d}` });
  }
  return out;
}

export function isApprovedModel(provider: string, modelId: string): boolean {
  if (provider === 'anthropic') return isApprovedAnthropicModel(modelId);
  return approvedModels().some((m) => m.provider === provider && m.model_id === modelId);
}
