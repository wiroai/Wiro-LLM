import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  type EmbeddingModelV4,
  type Experimental_VideoModelV4,
  type ImageModelV4,
  type LanguageModelV4,
  NoSuchModelError,
  type ProviderV4,
  type SpeechModelV4,
  type TranscriptionModelV4,
} from '@ai-sdk/provider';
import {
  type FetchFunction,
  loadApiKey,
  withoutTrailingSlash,
  withUserAgentSuffix,
} from '@ai-sdk/provider-utils';
import { VERSION } from './version';
import type { WiroChatModelId } from './wiro-chat-model-id';
import { WiroImageModel } from './wiro-image-model';
import type {
  WiroImageModelId,
  WiroSpeechModelId,
  WiroTranscriptionModelId,
  WiroVideoModelId,
} from './wiro-media-model-ids';
import { wiroMetadataExtractor } from './wiro-metadata-extractor';
import {
  DEFAULT_RUN_BASE_URL,
  loadModelSchema,
  splitModelId,
  type WiroPollSettings,
  type WiroRunConfig,
  WiroSchemaCache,
} from './wiro-run-api';
import { WiroSpeechModel } from './wiro-speech-model';
import { WiroTranscriptionModel } from './wiro-transcription-model';
import { WiroVideoModel } from './wiro-video-model';

export interface WiroProviderSettings {
  /**
   * Your Wiro project credential: the API key for an API Key Only project and
   * `API_KEY:API_SECRET` for a Signature project. Chat calls send it as
   * `Authorization: Bearer <apiKey>`; image, speech, transcription and video
   * calls send the key and, for a Signature project, sign every request.
   * Defaults to the `WIRO_API_KEY` environment variable.
   */
  apiKey?: string;

  /**
   * Base URL of the LLM gateway, which chat models use. Defaults to
   * `https://llm.wiro.ai/v1`.
   */
  baseURL?: string;

  /**
   * Base URL of the Run API, which image, speech, transcription and video
   * models use. Defaults to `https://api.wiro.ai/v1`.
   */
  runBaseURL?: string;

  /**
   * How image, speech and transcription calls wait for their task. Video
   * calls take the AI SDK's own `poll` option instead.
   */
  poll?: WiroPollSettings;

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

  /**
   * Creates an image model for `generateImage`, such as `pruna/p-image` or,
   * for image editing, `google/nano-banana`.
   */
  image(modelId: WiroImageModelId): ImageModelV4;

  /**
   * Creates an image model for `generateImage`.
   */
  imageModel(modelId: WiroImageModelId): ImageModelV4;

  /**
   * Creates a text-to-speech model for `generateSpeech`, such as
   * `elevenlabs/eleven-v4-turbo`.
   */
  speech(modelId: WiroSpeechModelId): SpeechModelV4;

  /**
   * Creates a text-to-speech model for `generateSpeech`.
   */
  speechModel(modelId: WiroSpeechModelId): SpeechModelV4;

  /**
   * Creates a speech-to-text model for `transcribe`, such as
   * `openai/whisper-large-v3`.
   */
  transcription(modelId: WiroTranscriptionModelId): TranscriptionModelV4;

  /**
   * Creates a speech-to-text model for `transcribe`.
   */
  transcriptionModel(modelId: WiroTranscriptionModelId): TranscriptionModelV4;

  /**
   * Creates a video model for `experimental_generateVideo`, such as
   * `bytedance/seedance-v1-pro-fast`.
   */
  video(modelId: WiroVideoModelId): Experimental_VideoModelV4;

  /**
   * Creates a video model for `experimental_generateVideo`.
   */
  videoModel(modelId: WiroVideoModelId): Experimental_VideoModelV4;
}

/**
 * Creates a Wiro provider instance.
 */
export function createWiro(options: WiroProviderSettings = {}): WiroProvider {
  // Read on every request, so the default instance can be imported before
  // WIRO_API_KEY is set.
  const credential = () =>
    loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: 'WIRO_API_KEY',
      description: 'Wiro',
    });

  const gateway = createOpenAICompatible<WiroChatModelId, string, string, string>({
    name: 'wiro',
    baseURL: withoutTrailingSlash(options.baseURL) ?? 'https://llm.wiro.ai/v1',
    apiKey: credential,
    headers: withUserAgentSuffix(options.headers ?? {}, `ai-sdk/wiro/${VERSION}`),
    fetch: options.fetch,
    includeUsage: true,
    supportsStructuredOutputs: true,
    metadataExtractor: wiroMetadataExtractor,
  });

  const request = {
    baseURL: withoutTrailingSlash(options.runBaseURL) ?? DEFAULT_RUN_BASE_URL,
    credential,
    headers: () => ({ ...options.headers }),
    fetch: options.fetch,
  };
  // One cache for every model of this provider, so each model is described once.
  const schemas = new WiroSchemaCache((modelId) => loadModelSchema(request, modelId));
  const runConfig = (kind: string): WiroRunConfig => ({
    ...request,
    provider: `wiro.${kind}`,
    poll: { ...options.poll },
    schemas,
  });

  const checkModelId = (
    modelId: string,
    modelType: 'imageModel' | 'speechModel' | 'transcriptionModel' | 'videoModel',
  ) => {
    if (!splitModelId(modelId)) {
      throw new NoSuchModelError({
        modelId,
        modelType,
        message: `"${modelId}" is not a Wiro model ID. Model IDs are owner/model, such as pruna/p-image.`,
      });
    }
  };

  const createChatModel = (modelId: WiroChatModelId): LanguageModelV4 => gateway.chatModel(modelId);

  const createImageModel = (modelId: WiroImageModelId): ImageModelV4 => {
    checkModelId(modelId, 'imageModel');
    return new WiroImageModel(modelId, runConfig('image'));
  };

  const createSpeechModel = (modelId: WiroSpeechModelId): SpeechModelV4 => {
    checkModelId(modelId, 'speechModel');
    return new WiroSpeechModel(modelId, runConfig('speech'));
  };

  const createTranscriptionModel = (modelId: WiroTranscriptionModelId): TranscriptionModelV4 => {
    checkModelId(modelId, 'transcriptionModel');
    return new WiroTranscriptionModel(modelId, runConfig('transcription'));
  };

  const createVideoModel = (modelId: WiroVideoModelId): Experimental_VideoModelV4 => {
    checkModelId(modelId, 'videoModel');
    return new WiroVideoModel(modelId, runConfig('video'));
  };

  const provider = function (modelId: WiroChatModelId) {
    if (new.target) {
      throw new Error('The Wiro model function cannot be called with the new keyword.');
    }

    return createChatModel(modelId);
  };

  provider.specificationVersion = 'v4' as const;
  provider.languageModel = createChatModel;
  provider.chatModel = createChatModel;
  provider.image = createImageModel;
  provider.imageModel = createImageModel;
  provider.speech = createSpeechModel;
  provider.speechModel = createSpeechModel;
  provider.transcription = createTranscriptionModel;
  provider.transcriptionModel = createTranscriptionModel;
  provider.video = createVideoModel;
  provider.videoModel = createVideoModel;

  // The LLM gateway serves chat models only.
  provider.embeddingModel = (modelId: string): EmbeddingModelV4 => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };

  return provider;
}

/**
 * Default Wiro provider instance. It reads the key from `WIRO_API_KEY`.
 */
export const wiro = createWiro();
