// A Wiro model's parameters, as Tool/Detail describes them, and the helpers
// that map the AI SDK's own settings (size, aspect ratio, voice, language and
// so on) onto them. Models in one category name their settings differently
// (`aspectRatio` or `ratio`, `voice` or `speaker`, `samples` or `maxImages`),
// so the helpers find a setting by its id and match values against the
// options the model lists.

export interface WiroParameterOption {
  value: string;
  label?: string;
}

export interface WiroParameter {
  id: string;
  /** The Tool/Detail type in lowercase, such as `select`, `number` or `fileinput`. */
  type: string;
  label: string;
  required: boolean;
  advanced: boolean;
  defaultValue: unknown;
  options: WiroParameterOption[];
  /** The options are loaded from a list, so `options` may not hold them all. */
  openOptions: boolean;
  min?: number;
  max?: number;
}

export interface WiroModelSchema {
  modelId: string;
  title: string;
  categories: string[];
  parameters: WiroParameter[];
}

export const FILE_TYPES = new Set(['fileinput', 'multifileinput', 'combinefileinput']);
const SELECT_TYPES = new Set(['select', 'selectwithcover']);
const NUMBER_TYPES = new Set(['number', 'float', 'range']);
const TEXT_TYPES = new Set(['text', 'textarea']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrue(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === 'true';
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseOption(option: unknown): WiroParameterOption | undefined {
  if (!isRecord(option)) return undefined;
  const value = option.value ?? option.id;
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  const label = option.text ?? option.label ?? option.name;
  return {
    value: String(value),
    ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
  };
}

function parseParameter(item: Record<string, unknown>): WiroParameter | undefined {
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id) return undefined;
  const type = String(item.type ?? 'text').toLowerCase();
  const options: WiroParameterOption[] = [];
  for (const raw of Array.isArray(item.options) ? item.options : []) {
    const option = parseOption(raw);
    if (option && !options.some((existing) => existing.value === option.value)) {
      options.push(option);
    }
  }
  const defaultValue =
    type === 'checkbox' && Object.hasOwn(item, 'value')
      ? item.value
      : (item.defaultvalue ?? item.value ?? item.default);
  const openOptions =
    item.optionsLoad !== undefined &&
    item.optionsLoad !== null &&
    item.optionsLoad !== '' &&
    item.optionsLoad !== false;
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id;
  return {
    id,
    type,
    label,
    required: isTrue(item.required),
    advanced: isTrue(item.advanced),
    defaultValue,
    options,
    openOptions,
    ...(NUMBER_TYPES.has(type)
      ? {
          min: optionalNumber(item.minvalue ?? item.min),
          max: optionalNumber(item.maxvalue ?? item.max),
        }
      : {}),
  };
}

/** Reads one model row of a Tool/Detail answer. */
export function parseModelSchema(modelId: string, tool: unknown): WiroModelSchema {
  const row = isRecord(tool) ? tool : {};
  const parameters: WiroParameter[] = [];
  for (const group of Array.isArray(row.parameters) ? row.parameters : []) {
    if (!isRecord(group)) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (!isRecord(item)) continue;
      const parameter = parseParameter(item);
      if (parameter && !parameters.some((existing) => existing.id === parameter.id)) {
        parameters.push(parameter);
      }
    }
  }
  return {
    modelId,
    title: typeof row.title === 'string' && row.title ? row.title : modelId,
    categories: Array.isArray(row.categories) ? row.categories.map(String) : [],
    parameters,
  };
}

export function isFileParameter(parameter: WiroParameter): boolean {
  return FILE_TYPES.has(parameter.type);
}

export type WiroMediaKind = 'image' | 'video' | 'audio' | 'file';

/** The kind of file a file parameter takes, from its id and label. */
export function fileKind(parameter: WiroParameter): WiroMediaKind {
  const text = `${parameter.id} ${parameter.label}`.toLowerCase();
  if (/video|clip|mp4|footage/.test(text)) return 'video';
  if (/audio|voice|speech|song|music|sound|mp3|wav|vocal/.test(text)) return 'audio';
  if (
    /image|photo|picture|face|portrait|frame|logo|mask|garment|cloth|human|person|product|reference|selfie|avatar|style/.test(
      text,
    )
  ) {
    return 'image';
  }
  return 'file';
}

/** The file parameters of a kind, in the order the model lists them. */
export function fileParameters(schema: WiroModelSchema, kind: WiroMediaKind): WiroParameter[] {
  return schema.parameters.filter(
    (parameter) => isFileParameter(parameter) && fileKind(parameter) === kind,
  );
}

/** Whether a file parameter takes several files. */
export function takesSeveralFiles(parameter: WiroParameter): boolean {
  return parameter.type === 'multifileinput' || parameter.type === 'combinefileinput';
}

const PROMPT_ID =
  /^(prompt|text|script|lyrics|caption|captions|query|question|message|user_?prompt|input_?text)$/i;
const NEGATIVE = /negative/i;

/** The text parameter the prompt goes to. */
export function promptParameter(schema: WiroModelSchema): WiroParameter | undefined {
  const items = schema.parameters.filter(
    (parameter) => !isFileParameter(parameter) && TEXT_TYPES.has(parameter.type),
  );
  const positive = (parameter: WiroParameter) =>
    !NEGATIVE.test(parameter.id) && !NEGATIVE.test(parameter.label);
  return (
    items.find((parameter) => parameter.id === 'prompt') ??
    items.find((parameter) => PROMPT_ID.test(parameter.id) && positive(parameter)) ??
    items.find(
      (parameter) =>
        parameter.type === 'textarea' && /prompt/i.test(parameter.id) && positive(parameter),
    ) ??
    items.find(
      (parameter) => parameter.type === 'textarea' && parameter.required && positive(parameter),
    )
  );
}

/** The first setting, files left out, whose id matches. */
export function findParameter(schema: WiroModelSchema, id: RegExp): WiroParameter | undefined {
  return schema.parameters.find(
    (parameter) => !isFileParameter(parameter) && id.test(parameter.id),
  );
}

export const SETTING_IDS = {
  aspectRatio: /^(aspect_?ratio|ratio)$/i,
  width: /^(width|image_?width)$/i,
  height: /^(height|image_?height)$/i,
  resolution: /^(resolution|image_?size|size|output_?resolution|video_?resolution)$/i,
  seed: /^seed$/i,
  imageCount:
    /^(samples|max_?images|num_?images|number_?of_?images|num_?outputs|image_?count|output_?count|batch_?count|n)$/i,
  voice: /^(voice|voice_?id|voice_?name|speaker|speaker_?id)$/i,
  language: /^(language|language_?code|lang|lang_?code|locale)$/i,
  outputFormat: /^(output_?format|audio_?format|format)$/i,
  speed: /^(speed|speaking_?rate|speech_?rate|tempo|rate)$/i,
  instructions: /^(instructions?|style_?instructions?|style_?prompt|voice_?description)$/i,
  duration: /^(duration|duration_?seconds|seconds|video_?length)$/i,
  fps: /^(fps|frame_?rate|frames_?per_?second)$/i,
  generateAudio: /^(generate_?audio|audio_?enabled|enable_?audio|with_?audio|sound)$/i,
  timestamps: /^(timestamps?|word_?timestamps|return_?timestamps)$/i,
} as const;

/**
 * The option a value stands for: the same value, the same value in another
 * case, or an option whose label is the value, such as `nova` for the voice
 * `af_nova` labelled "Nova".
 */
export function matchOption(parameter: WiroParameter, value: string): string | undefined {
  const wanted = value.trim().toLowerCase();
  for (const option of parameter.options) if (option.value === value) return option.value;
  for (const option of parameter.options) {
    if (option.value.trim().toLowerCase() === wanted) return option.value;
  }
  for (const option of parameter.options) {
    if (option.label?.toLowerCase() === wanted) return option.value;
  }
  return undefined;
}

/** Whether a select takes values that are not in its options. */
export function takesAnyValue(parameter: WiroParameter): boolean {
  return (
    !SELECT_TYPES.has(parameter.type) || parameter.openOptions || parameter.options.length === 0
  );
}

/** Up to `limit` option values, for messages. */
export function optionList(parameter: WiroParameter, limit = 12): string {
  const values = parameter.options.map((option) => option.value).filter(Boolean);
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} and ${values.length - limit} more` : shown;
}

/** A value in the form the model's setting takes. */
export function toSettingValue(
  parameter: WiroParameter,
  value: string | number | boolean,
): string | number {
  if (parameter.type === 'checkbox') return value === true || value === 'true' ? 'true' : 'false';
  if (NUMBER_TYPES.has(parameter.type)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  return String(value);
}

/** A true or false value in the form a setting takes: `true`/`false`, `on`/`off` or `yes`/`no`. */
export function booleanSettingValue(parameter: WiroParameter, value: boolean): string | undefined {
  if (parameter.type === 'checkbox') return value ? 'true' : 'false';
  const pairs: Array<[string, string]> = [
    ['true', 'false'],
    ['on', 'off'],
    ['yes', 'no'],
    ['enabled', 'disabled'],
  ];
  for (const [on, off] of pairs) {
    const onValue = matchOption(parameter, on);
    const offValue = matchOption(parameter, off);
    if (onValue !== undefined && offValue !== undefined) return value ? onValue : offValue;
  }
  return takesAnyValue(parameter) ? String(value) : undefined;
}

const CHECKBOX_OFF = new Set(['', 'false', '0', 'no', 'off', 'null', 'undefined']);

function catalogDefault(parameter: WiroParameter): string | number | undefined {
  const raw = parameter.defaultValue;
  if (parameter.type === 'checkbox') {
    if (typeof raw === 'boolean') return raw ? 'true' : 'false';
    return CHECKBOX_OFF.has(
      String(raw ?? '')
        .trim()
        .toLowerCase(),
    )
      ? 'false'
      : 'true';
  }
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'object') return undefined;
  if (NUMBER_TYPES.has(parameter.type)) return optionalNumber(raw);
  const text = String(raw);
  return SELECT_TYPES.has(parameter.type) ? (matchOption(parameter, text) ?? text) : undefined;
}

/**
 * Fills in required settings the request leaves out with their catalog
 * defaults, because a run refuses a request without them. Only selects,
 * numbers and checkboxes are filled: text and file defaults in the catalog are
 * samples from the model's page.
 */
export function fillRequiredDefaults(
  schema: WiroModelSchema,
  params: Record<string, unknown>,
): void {
  const fillable = new Set([...SELECT_TYPES, ...NUMBER_TYPES, 'checkbox']);
  for (const parameter of schema.parameters) {
    if (!parameter.required || !fillable.has(parameter.type)) continue;
    if (params[parameter.id] !== undefined) continue;
    const value = catalogDefault(parameter);
    if (value !== undefined) params[parameter.id] = value;
  }
}

/** The largest value a number setting or a select of numbers allows. */
export function largestValue(parameter: WiroParameter): number | undefined {
  if (parameter.max !== undefined) return parameter.max;
  const numbers = parameter.options
    .map((option) => Number(option.value))
    .filter((number) => Number.isFinite(number));
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

export function parseSize(size: string): { width: number; height: number } | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** A size as its smallest whole ratio, such as `16:9` for 1920x1080. */
export function ratioOf(width: number, height: number): string {
  const w = Math.round(width);
  const h = Math.round(height);
  const divisor = greatestCommonDivisor(w, h) || 1;
  return `${w / divisor}:${h / divisor}`;
}

function ratioValue(ratio: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!match) return undefined;
  const value = Number(match[1]) / Number(match[2]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The aspect ratio option for a ratio such as `16:9`: the same option, or one
 * with the same proportions written another way (`1.91:1`, `2:1`).
 */
export function matchRatio(parameter: WiroParameter, ratio: string): string | undefined {
  const exact = matchOption(parameter, ratio);
  if (exact !== undefined) return exact;
  const wanted = ratioValue(ratio);
  if (wanted === undefined) return undefined;
  for (const option of parameter.options) {
    const value = ratioValue(option.value);
    if (value !== undefined && Math.abs(value - wanted) / wanted < 0.01) return option.value;
  }
  return undefined;
}

/**
 * The pixel count an option of a resolution setting stands for: `1024x768`
 * as written, `720p` as a 16:9 frame 720 pixels high, `2k` as 2048x2048 for
 * images and 1920x1080 for video, and a plain number such as `512` as a square.
 */
function optionPixels(value: string, kind: 'image' | 'video'): number | undefined {
  const size = parseSize(value);
  if (size) return size.width * size.height;
  const progressive = /^\s*(\d+)\s*p\s*$/i.exec(value);
  if (progressive) {
    const height = Number(progressive[1]);
    return height * Math.round((height * 16) / 9);
  }
  const kilo = /^\s*(\d+(?:\.\d+)?)\s*k\s*$/i.exec(value);
  if (kilo) {
    const k = Number(kilo[1]);
    return kind === 'image' ? (k * 1024) ** 2 : k * 960 * (k * 540);
  }
  const plain = /^\s*(\d+)\s*$/.exec(value);
  if (plain) return Number(plain[1]) ** 2;
  return undefined;
}

/**
 * The option of a resolution setting closest to a size, by pixel count (and
 * by shape, for options written as `1024x768`). `exact` is false when the
 * option is clearly another size: more than about 10% off for sizes such as
 * `720p` or `1024x768`, and more than about 65% off for size classes such as
 * `1k` or `512`, which cover several shapes (1k at 3:2 is 1536x1024).
 */
export function pickResolution(
  parameter: WiroParameter,
  width: number,
  height: number,
  kind: 'image' | 'video',
): { value: string; exact: boolean } | undefined {
  const target = width * height;
  let best: { value: string; distance: number; tolerance: number } | undefined;
  for (const option of parameter.options) {
    const pixels = optionPixels(option.value, kind);
    if (pixels === undefined) continue;
    const size = parseSize(option.value);
    const shape = size ? Math.abs(Math.log(size.width / size.height / (width / height))) : 0;
    const distance = Math.abs(Math.log(pixels / target)) + shape;
    const sizeClass = /^\s*\d+(?:\.\d+)?\s*k\s*$|^\s*\d+\s*$/i.test(option.value);
    if (!best || distance < best.distance) {
      best = { value: option.value, distance, tolerance: sizeClass ? 0.5 : 0.1 };
    }
  }
  return best ? { value: best.value, exact: best.distance < best.tolerance } : undefined;
}

/**
 * The option of a select of numbers, such as a video duration of `5` or `10`
 * seconds, closest to a number.
 */
export function pickNumberOption(
  parameter: WiroParameter,
  value: number,
): { value: string; exact: boolean } | undefined {
  let best: { value: string; distance: number } | undefined;
  for (const option of parameter.options) {
    const number = Number.parseFloat(option.value);
    if (!Number.isFinite(number)) continue;
    const distance = Math.abs(number - value);
    if (!best || distance < best.distance) best = { value: option.value, distance };
  }
  return best ? { value: best.value, exact: best.distance < 1e-9 } : undefined;
}

let languageNames: Intl.DisplayNames | undefined;

function englishLanguageName(code: string): string | undefined {
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = languageNames.of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The option a language stands for. The AI SDK passes ISO 639-1 codes such as
 * `en`, while models list codes (`en`), names (`English`, `english`) or their
 * own letters labelled with names (`a` for "American English").
 */
export function matchLanguage(parameter: WiroParameter, language: string): string | undefined {
  const code = language.trim();
  const base = code.split(/[-_]/)[0] ?? code;
  const candidates = [code, base, englishLanguageName(code), englishLanguageName(base)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    const option = matchOption(parameter, candidate);
    if (option !== undefined) return option;
  }
  for (const candidate of candidates) {
    if (candidate.length < 4) continue;
    const word = new RegExp(`\\b${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const option = parameter.options.find(
      (option) => word.test(option.label ?? '') || word.test(option.value),
    );
    if (option) return option.value;
  }
  return undefined;
}
