import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type EmbeddingModelV4,
  type ImageModelV4,
  type LanguageModelV4,
  NoSuchModelError,
  type ProviderV4,
} from '@ai-sdk/provider';
import {
  type FetchFunction,
  loadApiKey,
  withoutTrailingSlash,
  withUserAgentSuffix,
} from '@ai-sdk/provider-utils';
import { VERSION } from './version';
import type { WiroChatModelId } from './wiro-chat-model-id';
import { wiroMetadataExtractor } from './wiro-metadata-extractor';

export interface WiroProviderSettings {
  /**
   * Your Wiro project credential, sent as `Authorization: Bearer <apiKey>`.
   * Use the API key for an API Key Only project and `API_KEY:API_SECRET` for a
   * Signature project. Defaults to the `WIRO_API_KEY` environment variable.
   */
  apiKey?: string;

  /**
   * Base URL for the API calls. Defaults to `https://llm.wiro.ai/v1`.
   */
  baseURL?: string;

  /**
   * Extra headers to send with every request.
   */
  headers?: Record<string, string>;

  /**
   * Custom fetch implementation, for example to add logging or for tests.
   */
  fetch?: FetchFunction;
}

export interface WiroProvider extends ProviderV4 {
  /**
   * Creates a chat model on the Wiro LLM gateway.
   */
  (modelId: WiroChatModelId): LanguageModelV4;

  /**
   * Creates a chat model on the Wiro LLM gateway.
   */
  languageModel(modelId: WiroChatModelId): LanguageModelV4;

  /**
   * Creates a chat model on the Wiro LLM gateway.
   */
  chatModel(modelId: WiroChatModelId): LanguageModelV4;
}

/**
 * Creates a Wiro provider instance.
 */
export function createWiro(options: WiroProviderSettings = {}): WiroProvider {
  const gateway = createOpenAICompatible<WiroChatModelId, string, string, string>({
    name: 'wiro',
    baseURL: withoutTrailingSlash(options.baseURL) ?? 'https://llm.wiro.ai/v1',
    // Read on every request, so the default instance can be imported before
    // WIRO_API_KEY is set.
    apiKey: () =>
      loadApiKey({
        apiKey: options.apiKey,
        environmentVariableName: 'WIRO_API_KEY',
        description: 'Wiro',
      }),
    headers: withUserAgentSuffix(options.headers ?? {}, `ai-sdk/wiro/${VERSION}`),
    fetch: options.fetch,
    includeUsage: true,
    supportsStructuredOutputs: true,
    metadataExtractor: wiroMetadataExtractor,
  });

  const createChatModel = (modelId: WiroChatModelId): LanguageModelV4 => gateway.chatModel(modelId);

  const provider = function (modelId: WiroChatModelId) {
    if (new.target) {
      throw new Error('The Wiro model function cannot be called with the new keyword.');
    }

    return createChatModel(modelId);
  };

  provider.specificationVersion = 'v4' as const;
  provider.languageModel = createChatModel;
  provider.chatModel = createChatModel;

  provider.embeddingModel = (modelId: string): EmbeddingModelV4 => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };

  provider.imageModel = (modelId: string): ImageModelV4 => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider;
}

/**
 * Default Wiro provider instance. It reads the key from `WIRO_API_KEY`.
 */
export const wiro = createWiro();
