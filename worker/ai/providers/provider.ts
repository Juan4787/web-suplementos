import type { Deadline } from '../deadline';
import type { CanonicalAIRequest, CanonicalAIResponse, ModelDefinition, ProviderKey } from '../types';

export interface AIProvider {
  readonly key: ProviderKey;
  generate(
    model: ModelDefinition,
    request: CanonicalAIRequest,
    deadline: Deadline
  ): Promise<CanonicalAIResponse>;
}
