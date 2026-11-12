// A stand-in for the Wiro Run API in tests: Tool/Detail answers from model
// rows, Run starts a task, Task/Detail plays back task states in order, and
// output URLs serve file bodies. Every request is recorded.

import { vi } from 'vitest';

export interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The parsed JSON body of a JSON request. */
  json?: Record<string, unknown>;
  /** The fields of a multipart request: text, or a description of each file. */
  form?: Array<[string, string | { name: string; type: string; size: number }]>;
}

export interface ParameterSpec {
  id: string;
  type: string;
  label?: string;
  required?: boolean;
  advanced?: boolean;
  defaultvalue?: unknown;
  value?: unknown;
  options?: Array<string | { value: string; text: string }>;
  minvalue?: string | number;
  maxvalue?: string | number;
  optionsLoad?: unknown;
}

export function param(
  id: string,
  type: string,
  spec: Omit<ParameterSpec, 'id' | 'type'> = {},
): ParameterSpec {
  return { id, type, ...spec };
}

/** A Tool/Detail model row. */
export function tool(
  modelId: string,
  parameters: ParameterSpec[],
  extra: Record<string, unknown> = {},
) {
  const [owner, ...rest] = modelId.split('/');
  return {
    title: modelId,
    cleanslugowner: owner,
    cleanslugproject: rest.join('/'),
    categories: [],
    parameters: [
      {
        title: 'Inputs',
        items: parameters.map(({ options, ...item }) => ({
          label: item.id,
          ...item,
          required: Boolean(item.required),
          ...(options
            ? {
                options: options.map((option) =>
                  typeof option === 'string' ? { value: option, text: option } : option,
                ),
              }
            : {}),
        })),
      },
    ],
    ...extra,
  };
}

export interface MockFile {
  body: Uint8Array | string;
  contentType: string;
}

export interface MockWiroOptions {
  /** Model rows by model ID. Unknown models get `result: false`. */
  tools?: Record<string, unknown>;
  /** The answer to a Run request; defaults to task 100. */
  run?: (request: RecordedRequest) => unknown;
  /** Task states Task/Detail returns in order; the last one repeats. */
  tasks?: unknown[];
  /** Answers Task/Detail with an HTTP error for the first N calls. */
  taskFailures?: Array<{ status: number; body?: unknown }>;
  /** File bodies by URL. */
  files?: Record<string, MockFile | { status: number }>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function finishedTask(fields: Record<string, unknown> = {}) {
  return {
    id: '100',
    socketaccesstoken: 'token-100',
    status: 'task_postprocess_end',
    pexit: '0',
    totalcost: '0.005000000000',
    chargedcost: '0.005000000000',
    elapsedseconds: '6.0000',
    debugoutput: '',
    outputs: [],
    ...fields,
  };
}

export function runningTask(status = 'task_start', fields: Record<string, unknown> = {}) {
  return {
    id: '100',
    socketaccesstoken: 'token-100',
    status,
    pexit: '',
    totalcost: '0',
    chargedcost: null,
    outputs: [],
    ...fields,
  };
}

export function output(url: string, contenttype: string, name = url.split('/').pop() ?? 'file') {
  return { name, contenttype, size: '1000', url };
}

export function createMockWiro(options: MockWiroOptions = {}) {
  const requests: RecordedRequest[] = [];
  let taskCalls = 0;
  let taskFailureCount = 0;

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const parsed = new URL(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: RecordedRequest = {
      url,
      path: parsed.pathname,
      method: init?.method ?? 'GET',
      headers,
    };
    const body = init?.body;
    if (typeof body === 'string') {
      request.json = JSON.parse(body);
    } else if (body instanceof FormData) {
      request.form = [...body.entries()].map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value
          : { name: value.name, type: value.type, size: value.size },
      ]);
    }
    requests.push(request);

    if (parsed.pathname.endsWith('/Tool/Detail')) {
      const json = request.json ?? {};
      const modelId = `${json.slugowner}/${json.slugproject}`;
      const row = options.tools?.[modelId];
      if (!row) {
        return jsonResponse({
          result: false,
          errors: [{ code: 0, message: 'tool-not-accessible' }],
          tool: [],
        });
      }
      return jsonResponse({ result: true, errors: [], tool: [row] });
    }

    if (parsed.pathname.includes('/Run/')) {
      const answer = options.run?.(request) ?? {
        result: true,
        errors: [],
        taskid: '100',
        socketaccesstoken: 'token-100',
      };
      if (answer instanceof Response) return answer;
      return jsonResponse(answer);
    }

    if (parsed.pathname.endsWith('/Task/Detail')) {
      const failure = options.taskFailures?.[taskFailureCount];
      if (failure) {
        taskFailureCount += 1;
        return jsonResponse(
          failure.body ?? { result: false, errors: [{ message: 'busy' }] },
          failure.status,
        );
      }
      const tasks = options.tasks ?? [finishedTask()];
      const task = tasks[Math.min(taskCalls, tasks.length - 1)];
      taskCalls += 1;
      return jsonResponse({ result: true, errors: [], total: '1', tasklist: [task] });
    }

    const file = options.files?.[url];
    if (file && 'status' in file) return new Response('error', { status: file.status });
    if (file) {
      const data = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : file.body;
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'content-type': file.contentType },
      });
    }
    return new Response('not found', { status: 404 });
  });

  return {
    fetch,
    requests,
    runRequests: () => requests.filter((request) => request.path.includes('/Run/')),
    taskRequests: () => requests.filter((request) => request.path.endsWith('/Task/Detail')),
    toolRequests: () => requests.filter((request) => request.path.endsWith('/Tool/Detail')),
  };
}

/** A tiny PNG: the signature and an IHDR chunk are enough for media type detection. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

/** The start of an MP3 file with an ID3 tag. */
export const MP3_BYTES = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb,
]);

/** The start of an MP4 file. */
export const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
]);
