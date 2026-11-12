import type {
  SharedV4Warning,
  SpeechModelV4,
  SpeechModelV4CallOptions,
  SpeechModelV4Result,
} from '@ai-sdk/provider';
import type { WiroSpeechModelId } from './wiro-media-model-ids';
import {
  findParameter,
  matchLanguage,
  matchOption,
  optionList,
  pickNumberOption,
  promptParameter,
  SETTING_IDS,
  takesAnyValue,
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
  type WiroRunConfig,
} from './wiro-run-api';

/**
 * The output format option for a format such as `mp3` or `wav`: the same
 * option, or the model's default when it is of that format
 * (`mp3_44100_128`), or the first option of that format.
 */
function matchFormat(parameter: WiroParameter, format: string): string | undefined {
  const exact = matchOption(parameter, format);
  if (exact !== undefined) return exact;
  const wanted = format.trim().toLowerCase();
  const ofFormat = parameter.options.filter((option) => {
    const value = option.value.toLowerCase();
    return (
      value.startsWith(`${wanted}_`) || value.startsWith(`${wanted}-`) || value.startsWith(wanted)
    );
  });
  const fallback = String(parameter.defaultValue ?? '');
  return ofFormat.find((option) => option.value === fallback)?.value ?? ofFormat[0]?.value;
}

/** Sets one of the AI SDK's speech options on the model's matching setting. */
function applySetting(
  schema: WiroModelSchema,
  feature: string,
  value: string | number | undefined,
  parameter: WiroParameter | undefined,
  match: (parameter: WiroParameter, value: string) => string | undefined,
  params: Record<string, unknown>,
  warnings: SharedV4Warning[],
): void {
  if (value === undefined || value === '') return;
  if (!parameter) {
    warnings.push({
      type: 'unsupported',
      feature,
      details: `${schema.modelId} has no ${feature} setting.`,
    });
    return;
  }
  if (parameter.options.length === 0) {
    params[parameter.id] = toSettingValue(parameter, value);
    return;
  }
  const option = match(parameter, String(value));
  if (option !== undefined) params[parameter.id] = option;
  else if (takesAnyValue(parameter)) params[parameter.id] = toSettingValue(parameter, value);
  else {
    warnings.push({
      type: 'unsupported',
      feature,
      details: `${schema.modelId} has no ${feature} "${value}". It offers ${optionList(parameter)}.`,
    });
  }
}

export class WiroSpeechModel implements SpeechModelV4 {
  readonly specificationVersion = 'v4';

  constructor(
    readonly modelId: WiroSpeechModelId,
    private readonly config: WiroRunConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  async doGenerate(options: SpeechModelV4CallOptions): Promise<SpeechModelV4Result> {
    const timestamp = new Date();
    const { abortSignal, headers } = options;
    const schema = await this.config.schemas.get(this.modelId, abortSignal);
    const warnings: SharedV4Warning[] = [];
    const params: Record<string, unknown> = {};

    const text = promptParameter(schema);
    if (text) params[text.id] = options.text;
    else {
      warnings.push({
        type: 'unsupported',
        feature: 'text',
        details: `${this.modelId} has no text input, so the text was not sent.`,
      });
    }

    applySetting(
      schema,
      'voice',
      options.voice,
      findParameter(schema, SETTING_IDS.voice),
      matchOption,
      params,
      warnings,
    );
    applySetting(
      schema,
      'language',
      options.language,
      findParameter(schema, SETTING_IDS.language),
      matchLanguage,
      params,
      warnings,
    );
    applySetting(
      schema,
      'outputFormat',
      options.outputFormat,
      findParameter(schema, SETTING_IDS.outputFormat),
      matchFormat,
      params,
      warnings,
    );
    applySetting(
      schema,
      'instructions',
      options.instructions,
      findParameter(schema, SETTING_IDS.instructions),
      matchOption,
      params,
      warnings,
    );
    applySetting(
      schema,
      'speed',
      options.speed,
      findParameter(schema, SETTING_IDS.speed),
      (parameter, value) => {
        const pick = pickNumberOption(parameter, Number(value));
        return pick?.exact ? pick.value : matchOption(parameter, value);
      },
      params,
      warnings,
    );

    Object.assign(params, readWiroSettings(options.providerOptions));

    const { task, taskId, requestBody } = await runTask(this.config, {
      modelId: this.modelId,
      schema,
      params,
      inputs: [],
      headers,
      abortSignal,
    });

    const output = outputsOf(task, 'audio')[0];
    if (!output) throw noOutputError(this.modelId, taskId, 'audio');
    const audio = await downloadOutput(this.config, {
      url: output.url,
      modelId: this.modelId,
      taskId,
      abortSignal,
    });

    return {
      audio: audio.data,
      warnings,
      request: { body: JSON.stringify(requestBody) },
      response: {
        timestamp,
        modelId: this.modelId,
        headers: audio.headers,
      },
      providerMetadata: {
        wiro: {
          ...taskMetadata(task, taskId),
          url: output.url,
          mediaType: outputMediaType(output, 'audio/mpeg'),
        },
      },
    };
  }
}
