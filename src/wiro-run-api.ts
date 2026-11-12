// The Wiro Run API: starts a model run with `POST /Run/{owner}/{model}`,
// follows it with `POST /Task/Detail` and downloads what it made. Image,
// speech, transcription and video models are built on it.

import { APICallError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertBase64ToUint8Array,
  createBinaryResponseHandler,
  createStatusCodeErrorResponseHandler,
  delay,
  extractResponseHeaders,
  type FetchFunction,
  getFromApi,
  isAbortError,
  postFormDataToApi,
  postJsonToApi,
  type ResponseHandler,
  withUserAgentSuffix,
} from '@ai-sdk/provider-utils';
import { VERSION } from './version';
import { runApiAuthHeaders, splitCredential } from './wiro-auth';
import { WiroTaskError } from './wiro-error';
import {
  fillRequiredDefaults,
  parseModelSchema,
  type WiroModelSchema,
  type WiroParameter,
} from './wiro-model-schema';

export interface WiroPollSettings {
  /**
   * Time between two task status checks, in milliseconds. By default the
   * provider checks every 2 seconds for the first 15 seconds, every 5 seconds
   * up to a minute and every 10 seconds after that.
   */
  intervalMs?: number;

  /**
   * How long a call waits for its task to finish, in milliseconds. Defaults to
   * 600000 (10 minutes). A task that takes longer keeps running on Wiro.
   */
  timeoutMs?: number;
}

/** What a request to the Run API needs. */
export interface WiroRequestConfig {
  /** The Run API base URL, without a trailing slash. */
  baseURL: string;
  /** The project credential, read when a request is made. */
  credential: () => string;
  /** Extra headers for every request. */
  headers: () => Record<string, string | undefined>;
  fetch?: FetchFunction;
}

export interface WiroRunConfig extends WiroRequestConfig {
  /** The provider name the models report, such as `wiro.image`. */
  provider: string;
  poll: WiroPollSettings;
  schemas: WiroSchemaCache;
}

export const DEFAULT_RUN_BASE_URL = 'https://api.wiro.ai/v1';
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_STATUS_FAILURES = 5;
const DOWNLOAD_ATTEMPTS = 2;

const MISSING_SECRET_HINT =
  'This project uses signature authentication. Set the credential to API_KEY:API_SECRET.';

// The envelope every Run API answer comes in. HTTP 200 alone is not success:
// a refused request answers 200 with `result: false` and its reasons.
interface WiroEnvelope {
  result?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
}

function errorMessages(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const errors = (body as WiroEnvelope).errors;
  if (!Array.isArray(errors)) return undefined;
  const messages = errors
    .map((error) => (typeof error?.message === 'string' ? error.message.trim() : ''))
    .filter(Boolean);
  return messages.length > 0 ? messages.join('; ') : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Turns a failed HTTP answer into an APICallError with Wiro's own reason. */
function failedResponseHandler(hasSecret: boolean): ResponseHandler<APICallError> {
  return async ({ response, url, requestBodyValues }) => {
    const responseBody = await response.text();
    const responseHeaders = extractResponseHeaders(response);
    const reason = errorMessages(parseJson(responseBody));
    const hint =
      response.status === 401 && !hasSecret && /signature/i.test(responseBody)
        ? MISSING_SECRET_HINT
        : undefined;
    return {
      responseHeaders,
      value: new APICallError({
        message: `Wiro AI error ${response.status}: ${hint ?? reason ?? (response.statusText || 'the request failed')}`,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
      }),
    };
  };
}

/** Reads a JSON answer and turns `result: false` into an APICallError. */
function envelopeResponseHandler<T>(): ResponseHandler<T> {
  return async ({ response, url, requestBodyValues }) => {
    const responseBody = await response.text();
    const responseHeaders = extractResponseHeaders(response);
    const value = parseJson(responseBody);
    if (typeof value !== 'object' || value === null) {
      throw new APICallError({
        message: 'Wiro AI sent an answer that is not JSON.',
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: false,
      });
    }
    if ((value as WiroEnvelope).result === false) {
      throw new APICallError({
        message: `Wiro AI refused the request: ${errorMessages(value) ?? 'no reason given'}`,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: false,
        data: value,
      });
    }
    return { value: value as T, rawValue: value, responseHeaders };
  };
}

async function requestHeaders(
  config: WiroRequestConfig,
  callHeaders: Record<string, string | undefined> | undefined,
): Promise<Record<string, string | undefined>> {
  const combined = combineHeaders(config.headers(), callHeaders);
  return combineHeaders(
    withUserAgentSuffix(combined, `ai-sdk/wiro/${VERSION}`),
    await runApiAuthHeaders(config.credential()),
  );
}

function hasSecret(config: WiroRequestConfig): boolean {
  try {
    return splitCredential(config.credential()).apiSecret !== undefined;
  } catch {
    return false;
  }
}

/** `owner` and `model` of a model ID such as `pruna/p-image`. */
export function splitModelId(modelId: string): { owner: string; model: string } | undefined {
  const [owner, ...rest] = modelId.trim().split('/');
  const model = rest.join('/');
  return owner && model ? { owner, model } : undefined;
}

// --- Model schemas ----------------------------------------------------------

/**
 * Model schemas from Tool/Detail, kept for an hour per provider so a model is
 * described once rather than on every call.
 */
export class WiroSchemaCache {
  private readonly entries = new Map<string, { promise: Promise<WiroModelSchema>; time: number }>();

  constructor(
    private readonly load: (modelId: string) => Promise<WiroModelSchema>,
    private readonly ttlMs = 3_600_000,
  ) {}

  get(modelId: string, abortSignal?: AbortSignal): Promise<WiroModelSchema> {
    const now = Date.now();
    let entry = this.entries.get(modelId);
    if (!entry || now - entry.time > this.ttlMs) {
      const promise = this.load(modelId);
      entry = { promise, time: now };
      this.entries.set(modelId, entry);
      // A failed lookup is not kept, so the next call asks again.
      promise.catch(() => {
        if (this.entries.get(modelId)?.promise === promise) this.entries.delete(modelId);
      });
    }
    return raceAbort(entry.promise, abortSignal);
  }
}

function raceAbort<T>(promise: Promise<T>, abortSignal: AbortSignal | undefined): Promise<T> {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortSignal.reason);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Loads a model's parameters with `POST /Tool/Detail`. */
export async function loadModelSchema(
  config: WiroRequestConfig,
  modelId: string,
): Promise<WiroModelSchema> {
  const slug = splitModelId(modelId);
  if (!slug) throw invalidModelIdError(modelId);
  const url = `${config.baseURL}/Tool/Detail`;
  const body = { slugowner: slug.owner, slugproject: slug.model };
  const unknownModel = (responseBody?: string) =>
    new APICallError({
      message: `Wiro AI has no model called ${modelId}. Browse the models at https://wiro.ai/models.`,
      url,
      requestBodyValues: body,
      statusCode: 200,
      responseBody,
      isRetryable: false,
    });
  const { value } = await postJsonToApi<{ tool?: unknown[] }>({
    url,
    headers: await requestHeaders(config, undefined),
    body,
    failedResponseHandler: failedResponseHandler(hasSecret(config)),
    successfulResponseHandler: async (options) => {
      try {
        return await envelopeResponseHandler<{ tool?: unknown[] }>()(options);
      } catch (error) {
        // Tool/Detail answers an unknown model with `result: false`.
        if (APICallError.isInstance(error) && error.statusCode === 200) {
          throw unknownModel(error.responseBody);
        }
        throw error;
      }
    },
    fetch: config.fetch,
  });
  const tool = Array.isArray(value.tool) ? value.tool[0] : undefined;
  if (!tool) throw unknownModel();
  return parseModelSchema(modelId, tool);
}

export function invalidModelIdError(modelId: string): Error {
  return new Error(
    `"${modelId}" is not a Wiro model ID. Model IDs are owner/model, such as pruna/p-image.`,
  );
}

// --- Run requests -------------------------------------------------------------

/** A file for a file parameter: bytes, or a public URL that Wiro downloads. */
export type WiroInputFile =
  | { type: 'data'; data: Uint8Array; mediaType: string }
  | { type: 'url'; url: string };

/** A file from an AI SDK call: base64 text or bytes, or a URL. */
export function toInputFile(
  file:
    | { type: 'file'; data: string | Uint8Array; mediaType?: string }
    | { type: 'url'; url: string },
): WiroInputFile {
  if (file.type === 'url') return { type: 'url', url: file.url };
  const mediaType = file.mediaType || 'application/octet-stream';
  if (typeof file.data !== 'string') return { type: 'data', data: file.data, mediaType };
  const dataUrl = /^data:([^;,]*)?(?:;[^,]*)?;base64,(.*)$/s.exec(file.data);
  if (dataUrl) {
    return {
      type: 'data',
      data: convertBase64ToUint8Array(dataUrl[2] ?? ''),
      mediaType: dataUrl[1] || mediaType,
    };
  }
  return { type: 'data', data: convertBase64ToUint8Array(file.data), mediaType };
}

export interface WiroFileInput {
  parameter: WiroParameter;
  files: WiroInputFile[];
}

const FILE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'application/pdf': 'pdf',
};

function fileName(mediaType: string, index: number): string {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return `input-${index + 1}.${FILE_EXTENSIONS[type] ?? 'bin'}`;
}

/** The field a URL for a file parameter goes to, when the model has one. */
function urlFieldOf(parameter: WiroParameter, schema: WiroModelSchema): string | undefined {
  const candidates =
    parameter.type === 'multifileinput'
      ? [
          parameter.id.endsWith('Multiple')
            ? `${parameter.id.slice(0, -'Multiple'.length)}UrlMultiple`
            : `${parameter.id}Url`,
        ]
      : parameter.type === 'fileinput'
        ? [`${parameter.id}Url`]
        : [];
  return candidates.find((id) =>
    schema.parameters.some((candidate) => candidate.id.toLowerCase() === id.toLowerCase()),
  );
}

function formValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function toBlob(data: Uint8Array, mediaType: string): Blob {
  // Blob takes an ArrayBuffer-backed view; a copy guarantees one.
  return new Blob([new Uint8Array(data)], { type: mediaType });
}

export type WiroRunBody =
  | { type: 'json'; body: Record<string, unknown> }
  | { type: 'form'; form: FormData; values: Record<string, unknown> };

/**
 * The body of a run. Files given as bytes need a multipart request; files
 * given as URLs go in a JSON body. A `fileinput` takes its URL in its `...Url`
 * field when the model has one, a `multifileinput` takes URLs comma-separated
 * and a `combinefileinput` takes a list.
 */
export function buildRunBody(
  schema: WiroModelSchema,
  params: Record<string, unknown>,
  inputs: WiroFileInput[],
): WiroRunBody {
  const usedInputs = inputs.filter((input) => input.files.length > 0);
  const hasBytes = usedInputs.some((input) => input.files.some((file) => file.type === 'data'));

  if (!hasBytes) {
    const body: Record<string, unknown> = { ...params };
    for (const { parameter, files } of usedInputs) {
      const urls = files.map((file) => (file.type === 'url' ? file.url : ''));
      const urlField = urlFieldOf(parameter, schema);
      if (parameter.type === 'combinefileinput') body[parameter.id] = urls;
      else if (parameter.type === 'multifileinput') body[urlField ?? parameter.id] = urls.join(',');
      else body[urlField ?? parameter.id] = urls[0];
    }
    return { type: 'json', body };
  }

  const form = new FormData();
  const values: Record<string, unknown> = { ...params };
  const fileIds = new Set(usedInputs.map((input) => input.parameter.id));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || fileIds.has(key)) continue;
    const parameter = schema.parameters.find((candidate) => candidate.id === key);
    if (Array.isArray(value) && parameter?.type === 'combinefileinput') {
      for (const item of value) form.append(key, formValue(item));
    } else {
      form.append(key, formValue(value));
    }
  }
  let fileIndex = 0;
  for (const { parameter, files } of usedInputs) {
    const urlField = urlFieldOf(parameter, schema);
    const urls = files.flatMap((file) => (file.type === 'url' ? [file.url] : []));
    const blobs = files.flatMap((file) => (file.type === 'data' ? [file] : []));
    if (parameter.type === 'combinefileinput') {
      for (const file of files) {
        if (file.type === 'url') form.append(parameter.id, file.url);
        else
          form.append(
            parameter.id,
            toBlob(file.data, file.mediaType),
            fileName(file.mediaType, fileIndex++),
          );
      }
    } else if (blobs.length > 0) {
      for (const file of parameter.type === 'fileinput' ? blobs.slice(0, 1) : blobs) {
        form.append(
          parameter.id,
          toBlob(file.data, file.mediaType),
          fileName(file.mediaType, fileIndex++),
        );
      }
      if (urlField)
        form.append(urlField, parameter.type === 'multifileinput' ? urls.join(',') : '');
    } else {
      // Only URLs: the file field stays empty and the URL field carries them.
      if (urlField) {
        form.append(parameter.id, '');
        form.append(
          urlField,
          parameter.type === 'multifileinput' ? urls.join(',') : (urls[0] ?? ''),
        );
      } else {
        form.append(
          parameter.id,
          parameter.type === 'multifileinput' ? urls.join(',') : (urls[0] ?? ''),
        );
      }
    }
    values[parameter.id] = files.map((file) =>
      file.type === 'url' ? file.url : `<${file.mediaType} file, ${file.data.byteLength} bytes>`,
    );
  }
  return { type: 'form', form, values };
}

export interface WiroStartedTask {
  taskId: string;
  taskToken: string;
  responseHeaders?: Record<string, string>;
}

/** Starts a run with `POST /Run/{owner}/{model}`. */
export async function startTask(
  config: WiroRunConfig,
  {
    modelId,
    body,
    headers,
    abortSignal,
  }: {
    modelId: string;
    body: WiroRunBody;
    headers?: Record<string, string | undefined>;
    abortSignal?: AbortSignal;
  },
): Promise<WiroStartedTask> {
  const slug = splitModelId(modelId);
  if (!slug) throw invalidModelIdError(modelId);
  const url = `${config.baseURL}/Run/${encodeURIComponent(slug.owner)}/${encodeURIComponent(slug.model)}`;
  const shared = {
    url,
    headers: await requestHeaders(config, headers),
    failedResponseHandler: failedResponseHandler(hasSecret(config)),
    successfulResponseHandler: envelopeResponseHandler<{
      taskid?: string | number;
      socketaccesstoken?: string;
    }>(),
    abortSignal,
    fetch: config.fetch,
  };
  const { value, responseHeaders } =
    body.type === 'json'
      ? await postJsonToApi({ ...shared, body: body.body })
      : await postFormDataToApi({ ...shared, formData: body.form });

  const taskId = value.taskid === undefined || value.taskid === null ? '' : String(value.taskid);
  const taskToken = typeof value.socketaccesstoken === 'string' ? value.socketaccesstoken : '';
  if (!taskId && !taskToken) {
    throw new APICallError({
      message: 'Wiro AI accepted the run but sent no task ID.',
      url,
      requestBodyValues: body.type === 'json' ? body.body : body.values,
      statusCode: 200,
      isRetryable: false,
    });
  }
  return { taskId, taskToken, responseHeaders };
}

// --- Tasks --------------------------------------------------------------------

export interface WiroTaskOutput {
  name?: string;
  contenttype?: string;
  size?: string | number;
  url?: string;
  content?: unknown;
}

export interface WiroTask {
  id?: string | number;
  socketaccesstoken?: string;
  status?: string;
  pexit?: string | number | null;
  totalcost?: string | number | null;
  chargedcost?: string | number | null;
  elapsedseconds?: string | number | null;
  debugoutput?: string | null;
  outputs?: WiroTaskOutput[] | null;
}

export interface WiroTaskReference {
  taskId?: string;
  taskToken?: string;
}

/** Reads a task with `POST /Task/Detail`. */
export async function getTask(
  config: WiroRunConfig,
  reference: WiroTaskReference,
  {
    headers,
    abortSignal,
  }: { headers?: Record<string, string | undefined>; abortSignal?: AbortSignal },
): Promise<WiroTask> {
  const body = reference.taskToken
    ? { tasktoken: reference.taskToken }
    : { taskid: reference.taskId ?? '' };
  const url = `${config.baseURL}/Task/Detail`;
  const { value } = await postJsonToApi<{ tasklist?: WiroTask[] }>({
    url,
    headers: await requestHeaders(config, headers),
    body,
    failedResponseHandler: failedResponseHandler(hasSecret(config)),
    successfulResponseHandler: envelopeResponseHandler<{ tasklist?: WiroTask[] }>(),
    abortSignal,
    fetch: config.fetch,
  });
  const task = Array.isArray(value.tasklist) ? value.tasklist[0] : undefined;
  if (!task) {
    throw new APICallError({
      message: 'Wiro AI sent no task in its status answer.',
      url,
      requestBodyValues: body,
      statusCode: 200,
    });
  }
  return task;
}

const TERMINAL_STATUSES = new Set(['task_postprocess_end', 'task_cancel']);

export function isFinished(task: WiroTask): boolean {
  return TERMINAL_STATUSES.has(String(task.status ?? ''));
}

/**
 * A finished task failed only when its exit code is set and is not `0`. A
 * cancelled task gave no result either.
 */
export function taskOutcome(task: WiroTask): 'succeeded' | 'failed' | 'cancelled' | 'running' {
  const status = String(task.status ?? '');
  if (status === 'task_cancel') return 'cancelled';
  if (status !== 'task_postprocess_end') return 'running';
  const pexit = task.pexit === undefined || task.pexit === null ? '' : String(task.pexit).trim();
  return pexit === '' || pexit === '0' ? 'succeeded' : 'failed';
}

/** "Wiro task 123", or "the Wiro task" when the ID is not known. */
function taskLabel(taskId: string | undefined): string {
  return taskId ? `Wiro task ${taskId}` : 'the Wiro task';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pollInterval(config: WiroRunConfig, elapsedMs: number): number {
  if (config.poll.intervalMs !== undefined) return config.poll.intervalMs;
  if (elapsedMs < 15_000) return 2_000;
  if (elapsedMs < 60_000) return 5_000;
  return 10_000;
}

function isPermanentStatusError(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404)
  );
}

/** Waits until a task finishes, checking its status with `POST /Task/Detail`. */
export async function waitForTask(
  config: WiroRunConfig,
  {
    modelId,
    task: reference,
    headers,
    abortSignal,
  }: {
    modelId: string;
    task: WiroTaskReference;
    headers?: Record<string, string | undefined>;
    abortSignal?: AbortSignal;
  },
): Promise<WiroTask> {
  const timeoutMs = config.poll.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let failures = 0;
  let lastTask: WiroTask | undefined;

  for (;;) {
    abortSignal?.throwIfAborted();
    try {
      const task = await getTask(config, reference, { headers, abortSignal });
      failures = 0;
      lastTask = task;
      if (isFinished(task)) return task;
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) throw error;
      failures += 1;
      if (isPermanentStatusError(error) || failures >= MAX_STATUS_FAILURES) {
        throw new WiroTaskError({
          reason: 'status',
          taskId: reference.taskId,
          modelId,
          status: lastTask?.status,
          message: `The status of ${taskLabel(reference.taskId)} for ${modelId} could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
          cause: error,
        });
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WiroTaskError({
        reason: 'timeout',
        taskId: reference.taskId,
        modelId,
        status: lastTask?.status,
        message: `${capitalize(taskLabel(reference.taskId))} for ${modelId} did not finish within ${Math.round(
          timeoutMs / 1000,
        )} seconds. It keeps running on Wiro; raise the provider's poll.timeoutMs to wait longer.`,
      });
    }
    await delay(Math.min(pollInterval(config, Date.now() - startedAt), remaining), { abortSignal });
  }
}

/** The error for a task that finished without a result. */
export function unsuccessfulTaskError(
  task: WiroTask,
  modelId: string,
  outcome: 'failed' | 'cancelled',
): WiroTaskError {
  const taskId = task.id === undefined ? undefined : String(task.id);
  return new WiroTaskError({
    reason: outcome,
    taskId,
    modelId,
    status: task.status,
    // The model's own error log is not passed on.
    message:
      outcome === 'cancelled'
        ? `${capitalize(taskLabel(taskId))} for ${modelId} was cancelled.`
        : `${capitalize(taskLabel(taskId))} for ${modelId} failed. Check the prompt and settings, or try another model.`,
  });
}

function amount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * What the task cost, in USD: the charged amount once Wiro has recorded it,
 * and the task's price until then.
 */
export function taskCost(task: WiroTask): number | undefined {
  return amount(task.chargedcost) ?? amount(task.totalcost);
}

/** The `providerMetadata.wiro` fields every task result carries. */
export function taskMetadata(
  task: WiroTask,
  fallbackTaskId: string,
): Record<string, string | number> {
  const cost = taskCost(task);
  const elapsedSeconds = amount(task.elapsedseconds);
  return {
    taskId: task.id === undefined || task.id === null ? fallbackTaskId : String(task.id),
    ...(cost !== undefined ? { cost } : {}),
    ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
  };
}

export type WiroOutputKind = 'image' | 'video' | 'audio' | 'text' | 'json';

const OUTPUT_EXTENSIONS: Record<WiroOutputKind, RegExp> = {
  image: /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i,
  video: /\.(mp4|mov|m4v|webm|mkv|avi)$/i,
  audio: /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aiff?|weba)$/i,
  text: /\.(txt|srt|vtt)$/i,
  json: /\.json$/i,
};

/** The kind of a task output, from its content type, then its name or URL. */
export function outputKind(output: WiroTaskOutput): WiroOutputKind | undefined {
  const type = String(output.contenttype ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/json') return 'json';
  if (type.startsWith('text/')) return 'text';
  const names = [output.name ?? '', String(output.url ?? '').split('?')[0] ?? ''];
  for (const kind of ['image', 'video', 'audio', 'text', 'json'] as const) {
    if (names.some((name) => OUTPUT_EXTENSIONS[kind].test(name))) return kind;
  }
  return undefined;
}

/** The outputs of a kind that have a URL to download. */
export function outputsOf(
  task: WiroTask,
  kind: WiroOutputKind,
): Array<WiroTaskOutput & { url: string }> {
  return (task.outputs ?? []).filter(
    (output): output is WiroTaskOutput & { url: string } =>
      typeof output?.url === 'string' && output.url !== '' && outputKind(output) === kind,
  );
}

/** The media type of an output, from its content type or its file name. */
export function outputMediaType(output: WiroTaskOutput, fallback: string): string {
  const type = String(output.contenttype ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type?.includes('/') && type !== 'application/octet-stream') return type;
  const name = (output.name ?? String(output.url ?? '').split('?')[0]).toLowerCase();
  const extension = name.slice(name.lastIndexOf('.') + 1);
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    txt: 'text/plain',
    json: 'application/json',
  };
  return known[extension] ?? fallback;
}

/**
 * Downloads a task output. A failed download is tried once more, and then
 * reported as a WiroTaskError rather than an APICallError: the task is done
 * and paid for, so the call must not be retried as a whole.
 */
export async function downloadOutput(
  config: WiroRunConfig,
  {
    url,
    modelId,
    taskId,
    abortSignal,
  }: { url: string; modelId: string; taskId: string; abortSignal?: AbortSignal },
): Promise<{ data: Uint8Array; headers?: Record<string, string> }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const { value, responseHeaders } = await getFromApi({
        url,
        // The URL comes from the task answer, so it is checked before it is fetched.
        validateUrl: true,
        trustedOrigin: new URL(config.baseURL).origin,
        successfulResponseHandler: createBinaryResponseHandler(),
        failedResponseHandler: createStatusCodeErrorResponseHandler(),
        abortSignal,
        fetch: config.fetch,
      });
      return { data: value, headers: responseHeaders };
    } catch (error) {
      if (isAbortError(error) || abortSignal?.aborted) throw error;
      lastError = error;
    }
  }
  throw new WiroTaskError({
    reason: 'download',
    taskId,
    modelId,
    status: 'task_postprocess_end',
    message: `Wiro task ${taskId} for ${modelId} finished, but its output could not be downloaded from ${url}.`,
    cause: lastError,
  });
}

/**
 * The model settings a call passes in `providerOptions.wiro`. They go to the
 * model as they are and win over the settings the provider maps.
 */
export function readWiroSettings(
  providerOptions: Record<string, Record<string, unknown> | undefined> | undefined,
): Record<string, unknown> {
  const settings = providerOptions?.wiro;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return {};
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

export interface WiroFinishedTask {
  task: WiroTask;
  taskId: string;
  responseHeaders?: Record<string, string>;
  /** The run's settings, files described rather than included. */
  requestBody: Record<string, unknown>;
}

/**
 * Runs a model and waits for its task: fills in the required settings the
 * request leaves out, starts the run, waits for the task to finish and throws
 * a WiroTaskError when it failed or was cancelled.
 */
export async function runTask(
  config: WiroRunConfig,
  {
    modelId,
    schema,
    params,
    inputs,
    headers,
    abortSignal,
  }: {
    modelId: string;
    schema: WiroModelSchema;
    params: Record<string, unknown>;
    inputs: WiroFileInput[];
    headers?: Record<string, string | undefined>;
    abortSignal?: AbortSignal;
  },
): Promise<WiroFinishedTask> {
  fillRequiredDefaults(schema, params);
  const body = buildRunBody(schema, params, inputs);
  const started = await startTask(config, { modelId, body, headers, abortSignal });
  const task = await waitForTask(config, {
    modelId,
    task: {
      ...(started.taskId ? { taskId: started.taskId } : {}),
      ...(started.taskToken ? { taskToken: started.taskToken } : {}),
    },
    headers,
    abortSignal,
  });
  const outcome = taskOutcome(task);
  if (outcome === 'failed' || outcome === 'cancelled') {
    throw unsuccessfulTaskError(task, modelId, outcome);
  }
  return {
    task,
    taskId: started.taskId || String(task.id ?? ''),
    responseHeaders: started.responseHeaders,
    requestBody: body.type === 'json' ? body.body : body.values,
  };
}

/** The error for a finished task that made nothing of the kind a call needs. */
export function noOutputError(modelId: string, taskId: string, what: string): WiroTaskError {
  return new WiroTaskError({
    reason: 'no-output',
    taskId,
    modelId,
    status: 'task_postprocess_end',
    message: `Wiro task ${taskId} for ${modelId} finished without ${what}. Check that ${modelId} makes ${what}.`,
  });
}
