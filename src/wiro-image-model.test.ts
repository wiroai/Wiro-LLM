import { APICallError, NoSuchModelError } from '@ai-sdk/provider';
import { generateImage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createWiro, WiroTaskError } from './index';
import {
  createMockWiro,
  finishedTask,
  type MockWiroOptions,
  output,
  PNG_BYTES,
  param,
  runningTask,
  tool,
} from './test-helpers/mock-wiro';

const CDN = 'https://cdn1.wiro.ai/files';

const P_IMAGE = tool('pruna/p-image', [
  param('prompt', 'textarea', { required: true, defaultvalue: 'a sample prompt' }),
  param('aspectRatio', 'select', {
    defaultvalue: '16:9',
    options: ['16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1'],
  }),
  param('seed', 'text', { defaultvalue: '0' }),
]);

const GPT_IMAGE = tool('openai/gpt-image-2', [
  param('inputImage', 'combinefileinput', { defaultvalue: 'https://cdn.wiro.ai/sample.jpg' }),
  param('prompt', 'textarea', { required: true }),
  param('inputImageMask', 'combinefileinput'),
  param('resolution', 'select', {
    required: true,
    defaultvalue: '1k',
    options: ['1k', '2k', '4k'],
  }),
  param('ratio', 'select', {
    required: true,
    defaultvalue: '1:1',
    options: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'],
  }),
  param('quality', 'select', {
    required: true,
    defaultvalue: 'low',
    options: ['low', 'medium', 'high'],
  }),
  param('samples', 'number', { required: true, defaultvalue: '1', minvalue: '1', maxvalue: '10' }),
]);

const FLUX = tool('wiro/flux-2-dev', [
  param('inputImage', 'combinefileinput'),
  param('prompt', 'textarea', { required: true }),
  param('samples', 'number', { defaultvalue: '1', minvalue: '1', maxvalue: '8' }),
  param('seed', 'text', { defaultvalue: '0' }),
  param('width', 'number', { defaultvalue: '1024', minvalue: '0', maxvalue: '2048' }),
  param('height', 'number', { defaultvalue: '1024', minvalue: '0', maxvalue: '2048' }),
]);

const REMOVE_BACKGROUND = tool('wiro/remove-background', [
  param('inputImage', 'fileinput', { required: true }),
  param('inputImageUrl', 'text'),
]);

const TOOLS = {
  'pruna/p-image': P_IMAGE,
  'openai/gpt-image-2': GPT_IMAGE,
  'wiro/flux-2-dev': FLUX,
  'wiro/remove-background': REMOVE_BACKGROUND,
};

function setup(options: MockWiroOptions = {}) {
  const mock = createMockWiro({
    tools: TOOLS,
    tasks: [finishedTask({ outputs: [output(`${CDN}/0.png`, 'image/png')] })],
    files: { [`${CDN}/0.png`]: { body: PNG_BYTES, contentType: 'image/png' } },
    ...options,
  });
  const wiro = createWiro({ apiKey: 'test-key', fetch: mock.fetch, poll: { intervalMs: 0 } });
  return { ...mock, wiro };
}

describe('generateImage', () => {
  it('runs the model, waits for the task and returns the image', async () => {
    const { wiro, requests, runRequests } = setup({
      tasks: [
        runningTask('task_queue'),
        runningTask('task_start'),
        finishedTask({ outputs: [output(`${CDN}/0.png`, 'image/png')] }),
      ],
    });

    const result = await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A red lighthouse',
      aspectRatio: '1:1',
      seed: 42,
    });

    expect(result.image.uint8Array).toEqual(PNG_BYTES);
    expect(result.image.mediaType).toBe('image/png');
    expect(requests.map((request) => request.path)).toEqual([
      '/v1/Tool/Detail',
      '/v1/Run/pruna/p-image',
      '/v1/Task/Detail',
      '/v1/Task/Detail',
      '/v1/Task/Detail',
      '/files/0.png',
    ]);
    const run = runRequests()[0];
    expect(run?.url).toBe('https://api.wiro.ai/v1/Run/pruna/p-image');
    expect(run?.headers['x-api-key']).toBe('test-key');
    expect(run?.headers['content-type']).toBe('application/json');
    expect(run?.headers['user-agent']).toContain('ai-sdk/wiro/');
    expect(run?.json).toEqual({ prompt: 'A red lighthouse', aspectRatio: '1:1', seed: '42' });
    expect(requests[2]?.json).toEqual({ tasktoken: 'token-100' });
  });

  it('puts the task ID and cost in the provider metadata', async () => {
    const { wiro } = setup({
      tasks: [
        finishedTask({
          id: '777',
          totalcost: '0.010000000000',
          chargedcost: '0.008000000000',
          outputs: [output(`${CDN}/0.png`, 'image/png'), output(`${CDN}/1.png`, 'image/png')],
        }),
      ],
      files: {
        [`${CDN}/0.png`]: { body: PNG_BYTES, contentType: 'image/png' },
        [`${CDN}/1.png`]: { body: PNG_BYTES, contentType: 'image/png' },
      },
    });

    const result = await generateImage({
      model: wiro.image('wiro/flux-2-dev'),
      prompt: 'A fox',
      n: 2,
    });

    expect(result.images).toHaveLength(2);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.providerMetadata?.wiro).toMatchObject({
      taskId: '777',
      cost: 0.008,
      elapsedSeconds: 6,
    });
    expect(result.providerMetadata.wiro?.images).toEqual([
      { taskId: '777', cost: 0.004, url: `${CDN}/0.png`, mediaType: 'image/png' },
      { taskId: '777', cost: 0.004, url: `${CDN}/1.png`, mediaType: 'image/png' },
    ]);
  });

  it('uses the task price until the charge is recorded', async () => {
    const { wiro } = setup({
      tasks: [finishedTask({ chargedcost: null, outputs: [output(`${CDN}/0.png`, 'image/png')] })],
    });
    const result = await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A fox' });
    expect(result.calls[0]?.providerMetadata?.wiro).toMatchObject({ cost: 0.005 });
  });

  it('fills in required settings with their catalog defaults', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({ model: wiro.image('openai/gpt-image-2'), prompt: 'A cat' });
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'A cat',
      samples: 1,
      resolution: '1k',
      ratio: '1:1',
      quality: 'low',
    });
  });

  it('maps a size to the ratio and resolution of models without width and height', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateImage({
      model: wiro.image('openai/gpt-image-2'),
      prompt: 'A cat',
      size: '1536x1024',
    });
    expect(runRequests()[0]?.json).toMatchObject({ ratio: '3:2', resolution: '1k' });
    expect(result.warnings).toEqual([]);
  });

  it('sends a size as width and height', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({ model: wiro.image('wiro/flux-2-dev'), prompt: 'A cat', size: '768x512' });
    expect(runRequests()[0]?.json).toMatchObject({ width: 768, height: 512 });
  });

  it('turns an aspect ratio into a width and height', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('wiro/flux-2-dev'),
      prompt: 'A cat',
      aspectRatio: '16:9',
    });
    expect(runRequests()[0]?.json).toMatchObject({ width: 1360, height: 768 });
  });

  it('warns about an aspect ratio the model does not offer and leaves it out', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A cat',
      aspectRatio: '21:9',
    });
    expect(runRequests()[0]?.json).not.toHaveProperty('aspectRatio');
    expect(result.warnings).toEqual([
      {
        type: 'unsupported',
        feature: 'aspectRatio',
        details:
          'pruna/p-image has no 21:9 aspect ratio. It offers 16:9, 9:16, 3:2, 2:3, 4:3, 3:4, 1:1.',
      },
    ]);
  });

  it('asks for as many images per task as the model allows', async () => {
    const { wiro } = setup();
    const model = wiro.image('openai/gpt-image-2');
    const max = model.maxImagesPerCall;
    expect(typeof max === 'function' ? await max({ modelId: model.modelId }) : max).toBe(10);
    const single = wiro.image('pruna/p-image').maxImagesPerCall;
    expect(typeof single === 'function' ? await single({ modelId: 'pruna/p-image' }) : single).toBe(
      1,
    );
  });

  it('starts one task per image for models without an image count', async () => {
    const { wiro, runRequests, toolRequests } = setup();
    const result = await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A cat',
      n: 2,
    });
    expect(result.images).toHaveLength(2);
    expect(runRequests()).toHaveLength(2);
    expect(toolRequests()).toHaveLength(1);
  });

  it('describes each model once per provider', async () => {
    const { wiro, toolRequests } = setup();
    await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' });
    await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A dog' });
    expect(toolRequests()).toHaveLength(1);
  });

  it('sends image bytes in a multipart request', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('openai/gpt-image-2'),
      prompt: { text: 'Make it snowy', images: [PNG_BYTES] },
      providerOptions: { wiro: { quality: 'medium' } },
    });
    const run = runRequests()[0];
    expect(run?.json).toBeUndefined();
    expect(run?.headers['content-type']).toBeUndefined();
    expect(run?.form).toEqual([
      ['prompt', 'Make it snowy'],
      ['samples', '1'],
      ['quality', 'medium'],
      ['resolution', '1k'],
      ['ratio', '1:1'],
      ['inputImage', { name: 'input-1.png', type: 'image/png', size: PNG_BYTES.byteLength }],
    ]);
  });

  it('sends image URLs as a list for combined file inputs', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('openai/gpt-image-2'),
      prompt: {
        text: 'Merge them',
        images: ['https://example.com/a.png', 'https://example.com/b.png'],
      },
    });
    expect(runRequests()[0]?.json).toMatchObject({
      inputImage: ['https://example.com/a.png', 'https://example.com/b.png'],
    });
  });

  it('sends a mask to the mask input', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('openai/gpt-image-2'),
      prompt: {
        text: 'Fill it',
        images: ['https://example.com/a.png'],
        mask: 'https://example.com/m.png',
      },
    });
    expect(runRequests()[0]?.json).toMatchObject({
      inputImage: ['https://example.com/a.png'],
      inputImageMask: ['https://example.com/m.png'],
    });
  });

  it('sends a single file input URL in its Url field and works without a prompt', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('wiro/remove-background'),
      prompt: { images: ['https://example.com/photo.jpg'] },
    });
    expect(runRequests()[0]?.json).toEqual({ inputImageUrl: 'https://example.com/photo.jpg' });
  });

  it('sends a single file input as a file and an empty Url field', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('wiro/remove-background'),
      prompt: { images: [PNG_BYTES] },
    });
    expect(runRequests()[0]?.form).toEqual([
      ['inputImage', { name: 'input-1.png', type: 'image/png', size: PNG_BYTES.byteLength }],
      ['inputImageUrl', ''],
    ]);
  });

  it('warns when the model takes no input image', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: { text: 'A cat', images: ['https://example.com/a.png'] },
    });
    expect(runRequests()[0]?.json).toEqual({ prompt: 'A cat' });
    expect(result.warnings).toMatchObject([{ type: 'unsupported', feature: 'files' }]);
  });

  it('reports whether a model edits images and takes masks', async () => {
    const { wiro } = setup();
    expect(await wiro.image('openai/gpt-image-2').supportsFileInputs).toBe(true);
    expect(await wiro.image('openai/gpt-image-2').supportsMaskInputs).toBe(true);
    expect(await wiro.image('pruna/p-image').supportsFileInputs).toBe(false);
    expect(await wiro.image('nobody/unknown').supportsFileInputs).toBeUndefined();
  });

  it('lets providerOptions.wiro settings win', async () => {
    const { wiro, runRequests } = setup();
    await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A cat',
      aspectRatio: '1:1',
      providerOptions: { wiro: { aspectRatio: '9:16', disableSafetyChecker: 'false' } },
    });
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'A cat',
      aspectRatio: '9:16',
      disableSafetyChecker: 'false',
    });
  });
});

describe('task outcomes', () => {
  it('treats an empty exit code at the end as success', async () => {
    const { wiro } = setup({
      tasks: [finishedTask({ pexit: '', outputs: [output(`${CDN}/0.png`, 'image/png')] })],
    });
    const result = await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' });
    expect(result.images).toHaveLength(1);
  });

  it('keeps waiting through task_error until the task ends', async () => {
    const { wiro, taskRequests } = setup({
      tasks: [
        runningTask('task_error', { pexit: '1', debugerror: 'worker restart' }),
        finishedTask({ outputs: [output(`${CDN}/0.png`, 'image/png')] }),
      ],
    });
    const result = await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' });
    expect(result.images).toHaveLength(1);
    expect(taskRequests()).toHaveLength(2);
  });

  it('fails with a fixed message when the exit code is not 0', async () => {
    const { wiro, runRequests } = setup({
      tasks: [finishedTask({ id: '321', pexit: '1', debugerror: 'Traceback: secret stack' })],
    });
    const call = generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' });
    const error = await call.catch((caught: unknown) => caught);
    expect(WiroTaskError.isInstance(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'failed', taskId: '321', modelId: 'pruna/p-image' });
    expect((error as Error).message).toBe(
      'Wiro task 321 for pruna/p-image failed. Check the prompt and settings, or try another model.',
    );
    expect((error as Error).message).not.toContain('Traceback');
    // A failed task is not retried.
    expect(runRequests()).toHaveLength(1);
  });

  it('reports a cancelled task', async () => {
    const { wiro } = setup({ tasks: [finishedTask({ status: 'task_cancel', pexit: '' })] });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' }),
    ).rejects.toMatchObject({
      reason: 'cancelled',
      message: 'Wiro task 100 for pruna/p-image was cancelled.',
    });
  });

  it('reports a task without images', async () => {
    const { wiro } = setup({
      tasks: [finishedTask({ outputs: [output(`${CDN}/a.txt`, 'text/plain')] })],
    });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' }),
    ).rejects.toMatchObject({
      reason: 'no-output',
      taskId: '100',
    });
  });

  it('stops waiting at the timeout and names the task', async () => {
    const mock = createMockWiro({ tools: TOOLS, tasks: [runningTask('task_start')] });
    const wiro = createWiro({
      apiKey: 'test-key',
      fetch: mock.fetch,
      poll: { intervalMs: 0, timeoutMs: 1 },
    });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' }),
    ).rejects.toMatchObject({
      reason: 'timeout',
      taskId: '100',
    });
  });

  it('retries status checks that fail for a moment', async () => {
    const { wiro, taskRequests } = setup({ taskFailures: [{ status: 502 }, { status: 503 }] });
    const result = await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' });
    expect(result.images).toHaveLength(1);
    expect(taskRequests()).toHaveLength(3);
  });

  it('gives up after five failed status checks without starting another task', async () => {
    const { wiro, runRequests } = setup({
      taskFailures: Array.from({ length: 5 }, () => ({ status: 500 })),
    });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' }),
    ).rejects.toMatchObject({
      reason: 'status',
      taskId: '100',
    });
    expect(runRequests()).toHaveLength(1);
  });

  it('reports a failed download without running the model again', async () => {
    const { wiro, runRequests } = setup({ files: { [`${CDN}/0.png`]: { status: 500 } } });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat' }),
    ).rejects.toMatchObject({
      reason: 'download',
      taskId: '100',
    });
    expect(runRequests()).toHaveLength(1);
  });

  it('stops when the call is aborted', async () => {
    const controller = new AbortController();
    const { wiro } = setup({ tasks: [runningTask('task_start')] });
    const call = generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A cat',
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(call).rejects.toThrow(/abort/i);
  });
});

describe('Run API errors', () => {
  it("passes on Wiro's reason when it refuses a run, without retrying", async () => {
    const { wiro, runRequests, taskRequests } = setup({
      run: () => ({
        result: false,
        errors: [{ code: 0, message: 'Request parameter [prompt] required' }],
      }),
    });
    const error = await generateImage({
      model: wiro.image('pruna/p-image'),
      prompt: 'A cat',
    }).catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).message).toBe(
      'Wiro AI refused the request: Request parameter [prompt] required',
    );
    expect((error as APICallError).isRetryable).toBe(false);
    expect(runRequests()).toHaveLength(1);
    expect(taskRequests()).toHaveLength(0);
  });

  it('explains a rejected key', async () => {
    const { wiro } = setup({
      run: () =>
        new Response(
          JSON.stringify({
            result: false,
            errors: [{ message: 'Project authorization is not founded.' }],
          }),
          { status: 401 },
        ),
    });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat', maxRetries: 0 }),
    ).rejects.toThrow('Wiro AI error 401: Project authorization is not founded.');
  });

  it('says how to send the secret when a Signature project gets only the key', async () => {
    const { wiro } = setup({
      run: () =>
        new Response(
          JSON.stringify({
            result: false,
            errors: [{ message: 'x-signature and x-nonce headers are required' }],
          }),
          { status: 401 },
        ),
    });
    await expect(
      generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat', maxRetries: 0 }),
    ).rejects.toThrow(/Set the credential to API_KEY:API_SECRET/);
  });

  it('names an unknown model', async () => {
    const { wiro, runRequests } = setup();
    await expect(
      generateImage({ model: wiro.image('nobody/unknown'), prompt: 'A cat' }),
    ).rejects.toThrow('Wiro AI has no model called nobody/unknown.');
    expect(runRequests()).toHaveLength(0);
  });

  it('refuses a model ID without an owner', () => {
    expect(() => createWiro({ apiKey: 'test-key' }).image('p-image')).toThrow(NoSuchModelError);
  });
});
