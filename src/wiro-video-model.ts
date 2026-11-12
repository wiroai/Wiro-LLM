import type {
  JSONValue,
  SharedV4Warning,
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
  Experimental_VideoModelV4File as VideoModelV4File,
  Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
  Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
  Experimental_VideoModelV4OperationWebhook as VideoModelV4OperationWebhook,
} from '@ai-sdk/provider';
import type { WiroVideoModelId } from './wiro-media-model-ids';
import {
  booleanSettingValue,
  fileParameters,
  fillRequiredDefaults,
  findParameter,
  matchOption,
  matchRatio,
  optionList,
  parseSize,
  pickNumberOption,
  pickResolution,
  promptParameter,
  ratioOf,
  SETTING_IDS,
  takesAnyValue,
  takesSeveralFiles,
  toSettingValue,
  type WiroModelSchema,
  type WiroParameter,
} from './wiro-model-schema';
import {
  buildRunBody,
  getTask,
  noOutputError,
  outputMediaType,
  outputsOf,
  readWiroSettings,
  startTask,
  taskMetadata,
  taskOutcome,
  toInputFile,
  unsuccessfulTaskError,
  type WiroFileInput,
  type WiroRunConfig,
  type WiroTaskReference,
} from './wiro-run-api';

const NUMBER_TYPES = new Set(['number', 'float', 'range']);
const LAST_FRAME = /last|end|tail/i;
const REFERENCE = /reference|ref(?![a-z])/i;

function firstFrameParameter(schema: WiroModelSchema): WiroParameter | undefined {
  return fileParameters(schema, 'image').find(
    (parameter) =>
      !LAST_FRAME.test(parameter.id) &&
      !REFERENCE.test(parameter.id) &&
      !/mask/i.test(parameter.id),
  );
}

function lastFrameParameter(schema: WiroModelSchema): WiroParameter | undefined {
  return fileParameters(schema, 'image').find((parameter) => LAST_FRAME.test(parameter.id));
}

function referenceParameter(
  schema: WiroModelSchema,
  kind: 'image' | 'video',
): WiroParameter | undefined {
  const parameters = fileParameters(schema, kind);
  return (
    parameters.find((parameter) => REFERENCE.test(parameter.id)) ??
    (kind === 'video' ? parameters[0] : undefined)
  );
}

function isVideoFile(file: VideoModelV4File): boolean {
  const mediaType = file.mediaType ?? '';
  if (mediaType.startsWith('video/')) return true;
  return file.type === 'url' && /\.(mp4|mov|m4v|webm|mkv)(\?|$)/i.test(file.url);
}

/** Sets a number the AI SDK passes, such as the duration, on a number setting or a select of numbers. */
function applyNumber(
  schema: WiroModelSchema,
  feature: string,
  value: number | undefined,
  parameter: WiroParameter | undefined,
  params: Record<string, unknown>,
  warnings: SharedV4Warning[],
): void {
  if (value === undefined) return;
  if (!parameter) {
    warnings.push({
      type: 'unsupported',
      feature,
      details: `${schema.modelId} has no ${feature} setting.`,
    });
    return;
  }
  if (NUMBER_TYPES.has(parameter.type) || parameter.options.length === 0) {
    let number = value;
    if (parameter.min !== undefined && number < parameter.min) number = parameter.min;
    if (parameter.max !== undefined && parameter.max > 0 && number > parameter.max)
      number = parameter.max;
    if (number !== value) {
      warnings.push({
        type: 'compatibility',
        feature,
        details: `${schema.modelId} takes a ${feature} from ${parameter.min} to ${parameter.max}, so ${number} is used.`,
      });
    }
    params[parameter.id] = toSettingValue(parameter, number);
    return;
  }
  const pick = pickNumberOption(parameter, value);
  if (!pick) {
    warnings.push({
      type: 'unsupported',
      feature,
      details: `${schema.modelId} has no ${feature} of ${value}. It offers ${optionList(parameter)}.`,
    });
    return;
  }
  params[parameter.id] = pick.value;
  if (!pick.exact) {
    warnings.push({
      type: 'compatibility',
      feature,
      details: `${schema.modelId} has no ${feature} of ${value}. It offers ${optionList(parameter)}, so ${pick.value} is used.`,
    });
  }
}

function applyShape(
  schema: WiroModelSchema,
  { aspectRatio, resolution }: Pick<VideoModelV4CallOptions, 'aspectRatio' | 'resolution'>,
  params: Record<string, unknown>,
  warnings: SharedV4Warning[],
): void {
  const modelId = schema.modelId;
  const ratio = findParameter(schema, SETTING_IDS.aspectRatio);

  if (aspectRatio) {
    if (!ratio) {
      warnings.push({
        type: 'unsupported',
        feature: 'aspectRatio',
        details: `${modelId} takes no aspect ratio.`,
      });
    } else {
      const option =
        aspectRatio === 'adaptive'
          ? (matchOption(ratio, 'adaptive') ??
            matchOption(ratio, 'match_input_image') ??
            matchOption(ratio, 'auto'))
          : matchRatio(ratio, aspectRatio);
      if (option !== undefined) params[ratio.id] = option;
      else if (takesAnyValue(ratio) && aspectRatio !== 'adaptive') params[ratio.id] = aspectRatio;
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'aspectRatio',
          details: `${modelId} has no ${aspectRatio} aspect ratio. It offers ${optionList(ratio)}.`,
        });
      }
    }
  }

  if (resolution) {
    const size = parseSize(resolution);
    const setting = findParameter(schema, SETTING_IDS.resolution);
    const width = findParameter(schema, SETTING_IDS.width);
    const height = findParameter(schema, SETTING_IDS.height);
    if (!size) {
      warnings.push({
        type: 'unsupported',
        feature: 'resolution',
        details: `"${resolution}" is not a WIDTHxHEIGHT resolution.`,
      });
      return;
    }
    if (setting) {
      const pick = pickResolution(setting, size.width, size.height, 'video');
      if (pick) {
        params[setting.id] = pick.value;
        if (!pick.exact) {
          warnings.push({
            type: 'compatibility',
            feature: 'resolution',
            details: `${modelId} has no ${resolution} output, so it uses the closest resolution, ${pick.value}.`,
          });
        }
      } else if (takesAnyValue(setting)) params[setting.id] = resolution;
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'resolution',
          details: `${modelId} offers the resolutions ${optionList(setting)}.`,
        });
      }
    } else if (width && height && NUMBER_TYPES.has(width.type) && NUMBER_TYPES.has(height.type)) {
      params[width.id] = toSettingValue(width, size.width);
      params[height.id] = toSettingValue(height, size.height);
    } else if (!ratio) {
      warnings.push({
        type: 'unsupported',
        feature: 'resolution',
        details: `${modelId} takes no resolution.`,
      });
    }
    // Without an aspect ratio of its own, the call's resolution sets the shape.
    if (!aspectRatio && ratio && params[ratio.id] === undefined) {
      const option = matchRatio(ratio, ratioOf(size.width, size.height));
      if (option !== undefined) params[ratio.id] = option;
    }
  }
}

function addFile(inputs: WiroFileInput[], parameter: WiroParameter, file: VideoModelV4File): void {
  const existing = inputs.find((input) => input.parameter.id === parameter.id);
  if (!existing) inputs.push({ parameter, files: [toInputFile(file)] });
  else if (takesSeveralFiles(parameter)) existing.files.push(toInputFile(file));
}

/** Puts the call's start image, frame images and references into the model's file inputs. */
function assignVideoInputs(
  schema: WiroModelSchema,
  options: VideoModelV4CallOptions,
  warnings: SharedV4Warning[],
): WiroFileInput[] {
  const modelId = schema.modelId;
  const inputs: WiroFileInput[] = [];

  if (options.image) {
    const first = firstFrameParameter(schema);
    if (first) addFile(inputs, first, options.image);
    else {
      warnings.push({
        type: 'unsupported',
        feature: 'image',
        details: `${modelId} takes no start image.`,
      });
    }
  }

  for (const frame of options.frameImages ?? []) {
    if (frame.frameType !== 'last_frame') continue;
    const last = lastFrameParameter(schema);
    if (last) addFile(inputs, last, frame.image);
    else {
      warnings.push({
        type: 'unsupported',
        feature: 'frameImages',
        details: `${modelId} takes no end frame.`,
      });
    }
  }

  for (const reference of options.inputReferences ?? []) {
    const kind = isVideoFile(reference) ? 'video' : 'image';
    const parameter = referenceParameter(schema, kind);
    if (parameter) addFile(inputs, parameter, reference);
    else {
      warnings.push({
        type: 'unsupported',
        feature: 'inputReferences',
        details: `${modelId} takes no ${kind} references.`,
      });
    }
  }
  return inputs;
}

/** The task reference a started video run is followed with. */
function readOperation(operation: JSONValue): WiroTaskReference {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    throw new Error('The operation is not one a Wiro video model started.');
  }
  const record = operation as Record<string, unknown>;
  const taskId = typeof record.taskId === 'string' && record.taskId ? record.taskId : undefined;
  const taskToken =
    typeof record.taskToken === 'string' && record.taskToken ? record.taskToken : undefined;
  if (!taskId && !taskToken) throw new Error('The operation has no Wiro task ID.');
  return { ...(taskId ? { taskId } : {}), ...(taskToken ? { taskToken } : {}) };
}

export class WiroVideoModel implements VideoModelV4 {
  readonly specificationVersion = 'v4';
  /** Each task makes one video, so the AI SDK starts one task per video. */
  readonly maxVideosPerCall = 1;

  constructor(
    readonly modelId: WiroVideoModelId,
    private readonly config: WiroRunConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  /** Wiro posts the finished task to a `callbackUrl`, so the AI SDK can wait for a webhook. */
  async handleWebhookOption(options: {
    webhook: () => PromiseLike<{
      url: string;
      received: PromiseLike<VideoModelV4OperationWebhook>;
    }>;
  }): Promise<{ webhookUrl: string; received: PromiseLike<VideoModelV4OperationWebhook> }> {
    const { url, received } = await options.webhook();
    return { webhookUrl: url, received };
  }

  async doStart(
    options: VideoModelV4CallOptions & { webhookUrl?: string },
  ): Promise<VideoModelV4OperationStartResult> {
    const timestamp = new Date();
    const { abortSignal, headers } = options;
    const schema = await this.config.schemas.get(this.modelId, abortSignal);
    const warnings: SharedV4Warning[] = [];
    const params: Record<string, unknown> = {};

    if (options.prompt) {
      const prompt = promptParameter(schema);
      if (prompt) params[prompt.id] = options.prompt;
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'prompt',
          details: `${this.modelId} takes no prompt, so it was not sent.`,
        });
      }
    }

    applyShape(schema, options, params, warnings);
    applyNumber(
      schema,
      'duration',
      options.duration,
      findParameter(schema, SETTING_IDS.duration),
      params,
      warnings,
    );
    applyNumber(
      schema,
      'fps',
      options.fps,
      findParameter(schema, SETTING_IDS.fps),
      params,
      warnings,
    );

    if (options.seed !== undefined) {
      const seed = findParameter(schema, SETTING_IDS.seed);
      if (seed) params[seed.id] = toSettingValue(seed, options.seed);
      else
        warnings.push({
          type: 'unsupported',
          feature: 'seed',
          details: `${this.modelId} takes no seed.`,
        });
    }

    if (options.generateAudio !== undefined) {
      const setting = findParameter(schema, SETTING_IDS.generateAudio);
      const value = setting ? booleanSettingValue(setting, options.generateAudio) : undefined;
      if (setting && value !== undefined) params[setting.id] = value;
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'generateAudio',
          details: `${this.modelId} has no audio setting.`,
        });
      }
    }

    let inputs = assignVideoInputs(schema, options, warnings);

    const settings = readWiroSettings(options.providerOptions);
    Object.assign(params, settings);
    inputs = inputs.filter((input) => !(input.parameter.id in settings));
    if (options.webhookUrl) params.callbackUrl = options.webhookUrl;

    fillRequiredDefaults(schema, params);
    const started = await startTask(this.config, {
      modelId: this.modelId,
      body: buildRunBody(schema, params, inputs),
      headers,
      abortSignal,
    });

    return {
      operation: {
        ...(started.taskId ? { taskId: started.taskId } : {}),
        ...(started.taskToken ? { taskToken: started.taskToken } : {}),
      },
      warnings,
      providerMetadata: { wiro: { taskId: started.taskId } },
      response: { timestamp, modelId: this.modelId, headers: started.responseHeaders },
    };
  }

  async doStatus(options: {
    operation: JSONValue;
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  }): Promise<VideoModelV4OperationStatusResult> {
    const timestamp = new Date();
    const reference = readOperation(options.operation);
    const task = await getTask(this.config, reference, {
      headers: options.headers,
      abortSignal: options.abortSignal,
    });
    const taskId =
      task.id === undefined || task.id === null ? (reference.taskId ?? '') : String(task.id);
    const response = { timestamp, modelId: this.modelId, headers: undefined };
    const outcome = taskOutcome(task);

    if (outcome === 'running') {
      return {
        status: 'pending',
        // The AI SDK merges this into the result, so it carries nothing that goes stale.
        providerMetadata: { wiro: { taskId } },
        response,
      };
    }
    if (outcome === 'failed' || outcome === 'cancelled') {
      return {
        status: 'error',
        error: unsuccessfulTaskError(task, this.modelId, outcome).message,
        providerMetadata: { wiro: taskMetadata(task, taskId) },
        response,
      };
    }

    const outputs = outputsOf(task, 'video');
    if (outputs.length === 0) {
      return {
        status: 'error',
        error: noOutputError(this.modelId, taskId, 'a video').message,
        providerMetadata: { wiro: taskMetadata(task, taskId) },
        response,
      };
    }

    const metadata = taskMetadata(task, taskId);
    const share =
      typeof metadata.cost === 'number'
        ? Number((metadata.cost / outputs.length).toFixed(12))
        : undefined;
    return {
      status: 'completed',
      videos: outputs.map((output) => ({
        type: 'url' as const,
        url: output.url,
        mediaType: outputMediaType(output, 'video/mp4'),
      })),
      warnings: [],
      providerMetadata: {
        wiro: {
          ...metadata,
          videos: outputs.map((output) => ({
            taskId: metadata.taskId ?? taskId,
            ...(share !== undefined ? { cost: share } : {}),
            url: output.url,
            mediaType: outputMediaType(output, 'video/mp4'),
          })),
        },
      },
      response,
    };
  }
}
