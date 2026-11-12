import type {
  SharedV4Warning,
  TranscriptionModelV4,
  TranscriptionModelV4CallOptions,
  TranscriptionModelV4Result,
} from '@ai-sdk/provider';
import { validateDownloadUrl } from '@ai-sdk/provider-utils';
import type { WiroTranscriptionModelId } from './wiro-media-model-ids';
import {
  booleanSettingValue,
  fileKind,
  fileParameters,
  findParameter,
  isFileParameter,
  SETTING_IDS,
  type WiroModelSchema,
  type WiroParameter,
} from './wiro-model-schema';
import {
  downloadOutput,
  noOutputError,
  outputKind,
  readWiroSettings,
  runTask,
  taskMetadata,
  toInputFile,
  type WiroInputFile,
  type WiroRunConfig,
  type WiroTask,
} from './wiro-run-api';

type Transcript = Omit<
  TranscriptionModelV4Result,
  'warnings' | 'response' | 'providerMetadata' | 'request'
>;

type Segment = TranscriptionModelV4Result['segments'][number];

function audioParameter(schema: WiroModelSchema): WiroParameter | undefined {
  return (
    fileParameters(schema, 'audio').find((parameter) => !/reference|prompt/i.test(parameter.id)) ??
    fileParameters(schema, 'audio')[0] ??
    schema.parameters.find(
      (parameter) => isFileParameter(parameter) && fileKind(parameter) === 'file',
    )
  );
}

function seconds(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = record.text ?? record.word ?? record.segment ?? record.transcript;
  return typeof text === 'string' ? text : undefined;
}

/** A timed piece of a transcript: `{ text, start, end }` or `{ text, timestamp: [start, end] }`. */
function timedPiece(value: unknown): Segment | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = textOf(record);
  if (text === undefined) return undefined;
  const timestamp = Array.isArray(record.timestamp) ? record.timestamp : undefined;
  const start = seconds(record.start ?? record.startSecond ?? record.start_time ?? timestamp?.[0]);
  const end = seconds(record.end ?? record.endSecond ?? record.end_time ?? timestamp?.[1]);
  if (start === undefined || end === undefined) return undefined;
  return { text, startSecond: start, endSecond: end };
}

function timedPieces(value: unknown): Segment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const piece = timedPiece(item);
    return piece ? [piece] : [];
  });
}

function joinText(pieces: Segment[]): string {
  return pieces
    .map((piece) => piece.text.trim())
    .filter(Boolean)
    .join(' ');
}

/** A transcript from a JSON output, in the shapes speech-to-text models write. */
export function transcriptFromJson(value: unknown): Transcript | undefined {
  if (Array.isArray(value)) {
    const segments = timedPieces(value);
    if (segments.length > 0) {
      return {
        text: joinText(segments),
        segments,
        language: undefined,
        durationInSeconds: segments.at(-1)?.endSecond,
      };
    }
    const text = value.map(textOf).filter(Boolean).join(' ');
    return text
      ? { text, segments: [], language: undefined, durationInSeconds: undefined }
      : undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  // NeMo models such as Parakeet put their timings under `timestamp`.
  const timestamp =
    typeof record.timestamp === 'object' &&
    record.timestamp !== null &&
    !Array.isArray(record.timestamp)
      ? (record.timestamp as Record<string, unknown>)
      : {};
  const segments = timedPieces(
    record.segments ?? record.chunks ?? record.utterances ?? timestamp.segment,
  );
  const words = timedPieces(record.words ?? timestamp.word);
  const text =
    (typeof record.text === 'string' ? record.text : undefined) ??
    (typeof record.transcript === 'string' ? record.transcript : undefined) ??
    (segments.length > 0 ? joinText(segments) : undefined) ??
    (words.length > 0 ? joinText(words) : undefined);
  if (text === undefined) return undefined;
  const language = record.language ?? record.language_code ?? record.detected_language;
  return {
    text: text.trim(),
    segments,
    ...(words.length > 0 ? { words } : {}),
    language: typeof language === 'string' && language ? language : undefined,
    durationInSeconds:
      seconds(record.duration ?? record.audio_duration) ??
      segments.at(-1)?.endSecond ??
      words.at(-1)?.endSecond,
  };
}

function srtTime(value: string): number | undefined {
  const match = /(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/.exec(value);
  if (!match) return undefined;
  const [, hours = '0', minutes = '0', secs = '0', fraction = '0'] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(`0.${fraction}`);
}

/** A transcript from SubRip or WebVTT captions. */
export function transcriptFromCaptions(text: string): Transcript | undefined {
  const segments: Segment[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim());
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing === -1) continue;
    const [from = '', to = ''] = lines[timing]?.split('-->') ?? [];
    const start = srtTime(from);
    const end = srtTime(to);
    const words = lines
      .slice(timing + 1)
      .join(' ')
      .trim();
    if (start !== undefined && end !== undefined && words) {
      segments.push({ text: words, startSecond: start, endSecond: end });
    }
  }
  if (segments.length === 0) return undefined;
  return {
    text: joinText(segments),
    segments,
    language: undefined,
    durationInSeconds: segments.at(-1)?.endSecond,
  };
}

const TIMED_LINE =
  /^\s*\[?((?:\d+:)?\d+:\d+(?:[.,]\d+)?)\s*(?:-+>?|–)\s*((?:\d+:)?\d+:\d+(?:[.,]\d+)?)\]?\s*[/|:]?\s*(.*)$/;

/**
 * A transcript from text whose every line starts with its time span, such as
 * `00:00.0 - 00:05.3 / Hello there.` as Whisper writes it. Undefined for
 * other text.
 */
export function transcriptFromTimedLines(text: string): Transcript | undefined {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim());
  const segments: Segment[] = [];
  for (const line of lines) {
    const match = TIMED_LINE.exec(line);
    const start = match ? srtTime(match[1] ?? '') : undefined;
    const end = match ? srtTime(match[2] ?? '') : undefined;
    if (!match || start === undefined || end === undefined) return undefined;
    const words = (match[3] ?? '').trim();
    if (words) segments.push({ text: words, startSecond: start, endSecond: end });
  }
  if (segments.length === 0) return undefined;
  return {
    text: joinText(segments),
    segments,
    language: undefined,
    durationInSeconds: segments.at(-1)?.endSecond,
  };
}

function rawText(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const record = content as { raw?: unknown; answer?: unknown };
  if (Array.isArray(record.answer)) {
    const answer = record.answer.map((part) => textOf(part) ?? '').join('');
    if (answer.trim()) return answer.trim();
  }
  return typeof record.raw === 'string' && record.raw.trim() ? record.raw.trim() : undefined;
}

export class WiroTranscriptionModel implements TranscriptionModelV4 {
  readonly specificationVersion = 'v4';

  constructor(
    readonly modelId: WiroTranscriptionModelId,
    private readonly config: WiroRunConfig,
  ) {}

  get provider(): string {
    return this.config.provider;
  }

  async doGenerate(options: TranscriptionModelV4CallOptions): Promise<TranscriptionModelV4Result> {
    const audio: WiroInputFile = toInputFile({
      type: 'file',
      data: options.audio,
      mediaType: options.mediaType,
    });
    return this.transcribe(audio, options);
  }

  /**
   * Sends a public audio URL to Wiro, which downloads it itself. A URL Wiro
   * cannot reach, such as a localhost or private address, is left to the AI
   * SDK to download.
   */
  async doGenerateFromUrl(
    options: Omit<TranscriptionModelV4CallOptions, 'audio' | 'mediaType'> & { audio: URL },
  ): Promise<TranscriptionModelV4Result | undefined> {
    try {
      validateDownloadUrl(options.audio.href);
    } catch {
      return undefined;
    }
    return this.transcribe({ type: 'url', url: options.audio.href }, options);
  }

  private async transcribe(
    audio: WiroInputFile,
    options: Omit<TranscriptionModelV4CallOptions, 'audio' | 'mediaType'>,
  ): Promise<TranscriptionModelV4Result> {
    const timestamp = new Date();
    const { abortSignal, headers } = options;
    const schema = await this.config.schemas.get(this.modelId, abortSignal);
    const warnings: SharedV4Warning[] = [];
    const params: Record<string, unknown> = {};

    const input = audioParameter(schema);
    if (!input) {
      throw new Error(`${this.modelId} takes no audio file, so it cannot transcribe.`);
    }

    const granularities = options.timestampGranularities ?? [];
    if (granularities.length > 0) {
      const setting = findParameter(schema, SETTING_IDS.timestamps);
      const value = setting ? booleanSettingValue(setting, true) : undefined;
      if (setting && value !== undefined) params[setting.id] = value;
      else {
        warnings.push({
          type: 'unsupported',
          feature: 'timestampGranularities',
          details: `${this.modelId} has no timestamp setting.`,
        });
      }
    }

    const settings = readWiroSettings(options.providerOptions);
    Object.assign(params, settings);

    const { task, taskId } = await runTask(this.config, {
      modelId: this.modelId,
      schema,
      params,
      inputs: input.id in settings ? [] : [{ parameter: input, files: [audio] }],
      headers,
      abortSignal,
    });

    const transcript = await this.readTranscript(task, taskId, abortSignal);
    if (!transcript) throw noOutputError(this.modelId, taskId, 'a transcript');

    return {
      ...transcript,
      warnings,
      response: { timestamp, modelId: this.modelId },
      providerMetadata: { wiro: taskMetadata(task, taskId) },
    };
  }

  /** The transcript a task made: a model answer, or a JSON, text or caption file. */
  private async readTranscript(
    task: WiroTask,
    taskId: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<Transcript | undefined> {
    const outputs = task.outputs ?? [];

    for (const output of outputs) {
      if (output?.contenttype !== 'raw') continue;
      const text = rawText(output.content);
      if (text) return { text, segments: [], language: undefined, durationInSeconds: undefined };
    }

    const download = async (url: string) =>
      new TextDecoder().decode(
        (await downloadOutput(this.config, { url, modelId: this.modelId, taskId, abortSignal }))
          .data,
      );

    const files = outputs.filter(
      (output): output is typeof output & { url: string } =>
        typeof output?.url === 'string' && output.url !== '',
    );

    for (const output of files.filter((candidate) => outputKind(candidate) === 'json')) {
      try {
        const transcript = transcriptFromJson(JSON.parse(await download(output.url)));
        if (transcript) return transcript;
      } catch {
        // Not a transcript; try the other outputs.
      }
    }

    const textFiles = files.filter((candidate) => outputKind(candidate) === 'text');
    const captions = textFiles.filter((output) => /\.(srt|vtt)$/i.test(output.name ?? output.url));
    const plain = textFiles.filter((output) => !captions.includes(output));
    for (const output of plain) {
      const text = (await download(output.url)).trim();
      if (!text) continue;
      const lines = transcriptFromTimedLines(text);
      if (lines) return lines;
      const timed = captions[0]
        ? transcriptFromCaptions(await download(captions[0].url))
        : undefined;
      return {
        text,
        segments: timed?.segments ?? [],
        language: undefined,
        durationInSeconds: timed?.durationInSeconds,
      };
    }
    for (const output of captions) {
      const transcript = transcriptFromCaptions(await download(output.url));
      if (transcript) return transcript;
    }

    return undefined;
  }
}
