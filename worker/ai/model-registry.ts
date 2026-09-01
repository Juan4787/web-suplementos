import type { ModelDefinition, ModelKey } from './types';

export const CERTIFICATION_SUITE_VERSION = 'impulso-ai-contract-v1';

export const MODEL_REGISTRY: Record<ModelKey, ModelDefinition> = {
  gpt_oss_120b_groq_v1: {
    key: 'gpt_oss_120b_groq_v1',
    provider: 'groq',
    providerModel: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    providerLabel: 'Groq',
    certified: true,
    enabled: true,
    certificationSuite: CERTIFICATION_SUITE_VERSION,
    timeoutMs: 10_000,
    capabilities: { tools: true, reasoning: true, json: true }
  },
  glm_4_7_flash_cf_v1: {
    key: 'glm_4_7_flash_cf_v1',
    provider: 'cloudflare',
    providerModel: '@cf/zai-org/glm-4.7-flash',
    label: 'GLM 4.7 Flash',
    providerLabel: 'Cloudflare',
    certified: true,
    enabled: true,
    certificationSuite: CERTIFICATION_SUITE_VERSION,
    timeoutMs: 12_000,
    capabilities: { tools: true, reasoning: true, json: true }
  }
};

export const AUTOMATIC_ROUTE: readonly ModelKey[] = [
  'gpt_oss_120b_groq_v1',
  'glm_4_7_flash_cf_v1'
];

export const assertProductionModelsReady = (env: Env): void => {
  const unavailable = AUTOMATIC_ROUTE.filter((key) => {
    const model = MODEL_REGISTRY[key];
    return !model.enabled || !model.certified || model.certificationSuite !== CERTIFICATION_SUITE_VERSION;
  });

  if (unavailable.length > 0) {
    throw new Error('AI_MODELS_NOT_CERTIFIED');
  }

  if (String(env.GROQ_ZDR_CONFIRMED) !== 'true') {
    throw new Error('GROQ_ZDR_NOT_CONFIRMED');
  }
};
