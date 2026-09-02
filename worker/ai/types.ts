export type ModelKey =
  | 'gpt_oss_120b_groq_v1'
  | 'glm_4_7_flash_cf_v1';
export type ProviderKey = 'groq' | 'cloudflare';

export type CanonicalToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type CanonicalMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: CanonicalToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type CanonicalTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type CanonicalAIRequest = {
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  reasoning: 'low' | 'medium';
  maxCompletionTokens: number;
};

export type CanonicalAIResponse = {
  text: string | null;
  toolCalls: CanonicalToolCall[];
  finishReason: 'complete' | 'tool_call' | 'max_tokens';
  modelKey: ModelKey;
  provider: ProviderKey;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export type ModelDefinition = {
  key: ModelKey;
  provider: ProviderKey;
  providerModel: string;
  role?: 'primary' | 'fallback';
  label: string;
  providerLabel: string;
  certified: boolean;
  enabled: boolean;
  certificationSuite: string;
  timeoutMs: number;
  maxCompletionTokens: number;
  capabilities: {
    tools: true;
    reasoning: true;
    json: true;
  };
};

export type RequestContext = {
  currentDate: string;
  timezone: 'America/Argentina/Buenos_Aires';
  currency: 'ARS';
};

export type ExactEvidence = {
  id: string;
  label: string;
  value: string | number | boolean | null;
  formatted: string;
};

export type OrchestratorResult = {
  answer: string;
  modelKey: ModelKey;
  modelLabel: string;
  provider: ProviderKey;
  providerLabel: string;
  usedTools: string[];
  evidence: ExactEvidence[];
  providerTransitions: 0 | 1;
  fallbackUsed: boolean;
};
