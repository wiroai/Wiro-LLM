import type {
  ImageModelV4,
  ImageModelV4CallOptions,
  ImageModelV4File,
  ImageModelV4Result,
  SharedV4Warning,
} from '@ai-sdk/provider';
import type { WiroImageModelId } from './wiro-media-model-ids';
import {
  fileKind,
  fileParameters,
  findParameter,
  isFileParameter,
  largestValue,
  matchRatio,
  optionList,
  parseSize,
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
  downloadOutput,
  noOutputError,
  outputMediaType,
  outputsOf,
  readWiroSettings,
  runTask,
  taskMetadata,
  toInputFile,
  type WiroFileInput,
  type WiroRunConfig,
} from './wiro-run-api';

const NUMBER_TYPES = new Set(['number', 'float', 'range']);

/** Image inputs that are not the main picture: masks and the end frame of a video. */
const NOT_A_SOURCE_IMAGE = /mask|last|end|tail/i;

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

/**
 * A width and height with the given proportions and the pixel count of the
 * model's default size, within its limits.
 */
function sizeForRatio(
  width: WiroParameter,
  height: WiroParameter,
  ratio: number,
): { width: number; height: number } {
  const area = (Number(width.defaultValue) || 1024) * (Number(height.defaultValue) || 1024);
  let w = Math.sqrt(area * ratio);
  let h = w / ratio;
  const scale = Math.min(
    1,
    width.max && width.max > 0 ? width.max / w : 1,
    height.max && height.max > 0 ? height.max / h : 1,
  );
  w *= scale;
  h *= scale;
  return { width: roundTo16(w), height: roundTo16(h) };
}

function ratioNumber(aspectRatio: string): number | undefined {
  const [w, h] = aspectRatio.split(':').map(Number);
  return w && h && w > 0 && h > 0 ? w / h : undefined;
}

/** Maps `size` and `aspectRatio` onto the model's width, height, ratio and resolution settings. */
function applyShape(
  schema: WiroModelSchema,
  { size, aspectRatio }: Pick<ImageModelV4CallOptions, 'size' | 'aspectRatio'>,
  params: Record<string, unknown>,
  warnings: SharedV4Warning[],
): void {
  const modelId = schema.modelId;
  const width = findParameter(schema, SETTING_IDS.width);
  const height = findParameter(schema, SETTING_IDS.height);
  const hasDimensions =
    width !== undefined &&
    height !== undefined &&
    NUMBER_TYPES.has(width.type) &&
    NUMBER_TYPES.has(height.type);
  const ratio = findParameter(schema, SETTING_IDS.aspectRatio);
  const resolution = findParameter(schema, SETTING_IDS.resolution);

  if (size) {
    const parsed = parseSize(size);
    if (!parsed) {
      warnings.push({
        type: 'unsupported',
        feature: 'size',
        details: `"${size}" is not a WIDTHxHEIGHT size.`,
      });
    } else if (hasDimensions) {
      params[width.id] = toSettingValue(width, parsed.width);
      params[height.id] = toSettingValue(height, parsed.height);
    } else {
      let mapped = false;
      if (ratio) {
        const option = matchRatio(ratio, ratioOf(parsed.width, parsed.height));
        if (option !== undefined) {
          params[ratio.id] = option;
          mapped = true;
        }
      }
      if (resolution) {
        const pick = pickResolution(resolution, parsed.width, parsed.height, 'image');
        if (pick) {
          params[resolution.id] = pick.value;
          mapped = true;
          if (!pick.exact) {
            warnings.push({
              type: 'compatibility',
              feature: 'size',
              details: `${modelId} has no ${size} output, so it uses the closest resolution, ${pick.value}.`,
            });
          }
        }
      }
      if (!mapped) {
        warnings.push({
          type: 'unsupported',
          feature: 'size',
          details: ratio
            ? `${modelId} takes no size. Use aspectRatio with one of ${optionList(ratio)}.`
            : `${modelId} takes no size.`,
        });
      } else if (ratio && params[ratio.id] === undefined) {
        warnings.push({
          type: 'compatibility',
          feature: 'size',
          details: `${modelId} has no ${ratioOf(parsed.width, parsed.height)} aspect ratio. It offers ${optionList(ratio)}.`,
        });
      }
    }
  }

  if (aspectRatio) {
    if (ratio) {
      if (params[ratio.id] === undefined) {
        const option = matchRatio(ratio, aspectRatio);
        if (option !== undefined) params[ratio.id] = option;
        else if (takesAnyValue(ratio)) params[ratio.id] = aspectRatio;
        else {
          warnings.push({
            type: 'unsupported',
            feature: 'aspectRatio',
            details: `${modelId} has no ${aspectRatio} aspect ratio. It offers ${optionList(ratio)}.`,
          });
        }
      }
    } else if (hasDimensions) {
      const value = ratioNumber(aspectRatio);
      if (size) {
        warnings.push({
          type: 'unsupported',
          feature: 'aspectRatio',
          details: 'size is set, so aspectRatio is not used.',
        });
      } else if (value !== undefined) {
        const dimensions = sizeForRatio(width, height, value);
        params[width.id] = toSettingValue(width, dimensions.width);
        params[height.id] = toSettingValue(height, dimensions.height);
      }
    } else {
      warnings.push({
        type: 'unsupported',
        feature: 'aspectRatio',
        details: `${modelId} takes no aspect ratio.`,
      });
    }
  }
}

/** The model's inputs for source images, in the order it lists them. */
function sourceImageParameters(schema: WiroModelSchema): WiroParameter[] {
  return fileParameters(schema, 'image').filter(
    (parameter) => !NOT_A_SOURCE_IMAGE.test(parameter.id),
  );
}

function maskParameter(schema: WiroModelSchema): WiroParameter | undefined {
  return schema.parameters.find(
    (parameter) => isFileParameter(parameter) && /mask/i.test(`${parameter.id} ${parameter.label}`),
  );
}

/** Puts the prompt's images into the model's image inputs. */
function assignImages(
  schema: WiroModelSchema,
  files: ImageModelV4File[],
  warnings: SharedV4Warning[],
): WiroFileInput[] {
  const slots = sourceImageParameters(schema);
  if (slots.length === 0) {
    const generic = schema.parameters.find(
      (parameter) => isFileParameter(parameter) && fileKind(parameter) === 'file',
    );
    if (generic) slots.push(generic);
  }
  if (slots.length === 0) {
    warnings.push({
      type: 'unsupported',
      feature: 'files',
      details: `${schema.modelId} takes no input image, so the images in the prompt were not sent.`,
    });
    return [];
  }
  const inputs: WiroFileInput[] = [];
  const queue = files.map(toInputFile);
  for (const parameter of slots) {
    if (queue.length === 0) break;
    const taken = takesSeveralFiles(parameter) ? queue.splice(0) : queue.splice(0, 1);
    inputs.push({ parameter, files: taken });
  }
  if (queue.length > 0) {
    warnings.push({
      type: 'unsupported',
      feature: 'files',
      details: `${schema.modelId} takes ${files.length - queue.length} input image(s), so ${queue.length} were not sent.`,
    });
  }
  return inputs;
}

export class WiroImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';

  constructor(
    readonly modelId: WiroImageModelId,
    private readonly config: WiroRunConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  /**
   * The most images one task makes: the largest value of the model's image
   * count setting (`samples`, `maxImages` and the like), or 1.
   */
  readonly maxImagesPerCall = async (): Promise<number | undefined> => {
    try {
      const schema = await this.config.schemas.get(this.modelId);
      const count = findParameter(schema, SETTING_IDS.imageCount);
      return count ? Math.max(1, Math.floor(largestValue(count) ?? 1)) : 1;
    } catch {
      // The call itself reports why the model could not be described.
      return undefined;
    }
  };

  /** Whether the model takes input images, so it can edit images. */
  get supportsFileInputs(): PromiseLike<boolean | undefined> {
    return this.config.schemas.get(this.modelId).then(
      (schema) => sourceImageParameters(schema).length > 0,
      () => undefined,
    );
  }

  /** Whether the model takes a mask for inpainting. */
  get supportsMaskInputs(): PromiseLike<boolean | undefined> {
    return this.config.schemas.get(this.modelId).then(
      (schema) => maskParameter(schema) !== undefined,
      () => undefined,
    );
  }

  async doGenerate(options: ImageModelV4CallOptions): Promise<ImageModelV4Result> {
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

    const count = findParameter(schema, SETTING_IDS.imageCount);
    if (count) params[count.id] = toSettingValue(count, options.n);
    else if (options.n > 1) {
      warnings.push({
        type: 'unsupported',
        feature: 'n',
        details: `${this.modelId} makes one image per task.`,
      });
    }

    applyShape(schema, options, params, warnings);

    if (options.seed !== undefined) {
      const seed = findParameter(schema, SETTING_IDS.seed);
      if (seed) params[seed.id] = toSettingValue(seed, options.seed);
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'seed',
          details: `${this.modelId} takes no seed.`,
        });
      }
    }

    let inputs: WiroFileInput[] = [];
    if (options.files && options.files.length > 0) {
      inputs = assignImages(schema, options.files, warnings);
    }
    if (options.mask) {
      const mask = maskParameter(schema);
      if (mask) inputs.push({ parameter: mask, files: [toInputFile(options.mask)] });
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'mask',
          details: `${this.modelId} takes no mask.`,
        });
      }
    }

    // Settings in providerOptions.wiro win, files included.
    const settings = readWiroSettings(options.providerOptions);
    Object.assign(params, settings);
    inputs = inputs.filter((input) => !(input.parameter.id in settings));

    const { task, taskId, responseHeaders } = await runTask(this.config, {
      modelId: this.modelId,
      schema,
      params,
      inputs,
      headers,
      abortSignal,
    });

    const outputs = outputsOf(task, 'image');
    if (outputs.length === 0) throw noOutputError(this.modelId, taskId, 'an image');

    const images = await Promise.all(
      outputs.map(
        async (output) =>
          (
            await downloadOutput(this.config, {
              url: output.url,
              modelId: this.modelId,
              taskId,
              abortSignal,
            })
          ).data,
      ),
    );

    const metadata = taskMetadata(task, taskId);
    const share =
      typeof metadata.cost === 'number'
        ? Number((metadata.cost / outputs.length).toFixed(12))
        : undefined;

    return {
      images,
      warnings,
      providerMetadata: {
        wiro: {
          ...metadata,
          images: outputs.map((output) => ({
            taskId: metadata.taskId,
            ...(share !== undefined ? { cost: share } : {}),
            url: output.url,
            mediaType: outputMediaType(output, 'image/png'),
          })),
        },
      },
      response: { timestamp, modelId: this.modelId, headers: responseHeaders },
    };
  }
}
