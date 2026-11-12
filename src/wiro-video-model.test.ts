import {
  experimental_generateVideo as generateVideo,
  experimental_getVideoStatus as getVideoStatus,
  experimental_startVideo as startVideo,
} from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createWiro } from './index';
import {
  createMockWiro,
  finishedTask,
  type MockWiroOptions,
  MP4_BYTES,
  output,
  PNG_BYTES,
  param,
  runningTask,
  tool,
} from './test-helpers/mock-wiro';

const VIDEO_URL = 'https://cdn1.wiro.ai/files/video.mp4';

const SEEDANCE = tool('bytedance/seedance-pro-v1-5', [
  param('inputImage', 'combinefileinput'),
  param('inputImageLast', 'combinefileinput'),
  param('prompt', 'textarea'),
  param('resolution', 'select', {
    required: true,
    defaultvalue: '480p',
    options: ['480p', '720p', '1080p'],
  }),
  param('ratio', 'select', {
    required: true,
    defaultvalue: 'adaptive',
    options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
  }),
  param('duration', 'number', { required: true, defaultvalue: '5', minvalue: '4', maxvalue: '12' }),
  param('generateAudio', 'select', { defaultvalue: 'true', options: ['false', 'true'] }),
  param('seed', 'number', { defaultvalue: '1' }),
]);

const KLING = tool('klingai/kling-v2-5-turbo', [
  param('mode', 'select', { required: true, defaultvalue: 'std', options: ['std', 'pro'] }),
  param('inputImage', 'combinefileinput'),
  param('prompt', 'textarea'),
  param('duration', 'select', { required: true, defaultvalue: '5', options: ['5', '10'] }),
  param('ratio', 'select', {
    required: true,
    defaultvalue: '16:9',
    options: ['16:9', '9:16', '1:1'],
  }),
]);

const REFERENCE_MODEL = tool('bytedance/seedance-2-0-mini', [
  param('inputImage', 'combinefileinput'),
  param('inputImageReference', 'combinefileinput'),
  param('inputVideoReference', 'combinefileinput'),
  param('prompt', 'textarea'),
]);

function setup(options: MockWiroOptions = {}) {
  const mock = createMockWiro({
    tools: {
      'bytedance/seedance-pro-v1-5': SEEDANCE,
      'klingai/kling-v2-5-turbo': KLING,
      'bytedance/seedance-2-0-mini': REFERENCE_MODEL,
    },
    tasks: [
      runningTask('task_queue'),
      finishedTask({
        id: '400',
        totalcost: '0.048',
        chargedcost: '0.048',
        outputs: [output(VIDEO_URL, 'video/mp4')],
      }),
    ],
    ...options,
  });
  return { ...mock, wiro: createWiro({ apiKey: 'test-key', fetch: mock.fetch }) };
}

const download = vi.fn(async () => ({ data: MP4_BYTES, mediaType: 'video/mp4' }));
const poll = { intervalMs: 1, timeoutMs: 5_000 };

describe('experimental_generateVideo', () => {
  it('starts the run, polls the task and returns the video with its cost', async () => {
    const { wiro, runRequests, taskRequests } = setup();

    const result = await generateVideo({
      model: wiro.video('bytedance/seedance-pro-v1-5'),
      prompt: 'A paper boat on a pond',
      aspectRatio: '16:9',
      resolution: '1280x720',
      duration: 6,
      seed: 7,
      generateAudio: false,
      poll,
      download,
    });

    expect(runRequests()[0]?.json).toEqual({
      prompt: 'A paper boat on a pond',
      ratio: '16:9',
      resolution: '720p',
      duration: 6,
      seed: 7,
      generateAudio: 'false',
    });
    expect(taskRequests()).toHaveLength(2);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: new URL(VIDEO_URL) }));
    expect(result.video.uint8Array).toEqual(MP4_BYTES);
    expect(result.warnings).toEqual([]);
    expect(result.providerMetadata.wiro).toEqual({
      taskId: '400',
      cost: 0.048,
      elapsedSeconds: 6,
      videos: [{ taskId: '400', cost: 0.048, url: VIDEO_URL, mediaType: 'video/mp4' }],
    });
  });

  it('picks the closest duration a model offers and says so', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateVideo({
      model: wiro.video('klingai/kling-v2-5-turbo'),
      prompt: 'A fox in the snow',
      duration: 8,
      poll,
      download,
    });
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'A fox in the snow',
      duration: '10',
      mode: 'std',
      ratio: '16:9',
    });
    expect(result.warnings).toEqual([
      {
        type: 'compatibility',
        feature: 'duration',
        details: 'klingai/kling-v2-5-turbo has no duration of 8. It offers 5, 10, so 10 is used.',
      },
    ]);
  });

  it('keeps a duration within the range of a number setting', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateVideo({
      model: wiro.video('bytedance/seedance-pro-v1-5'),
      prompt: 'A fox',
      duration: 20,
      poll,
      download,
    });
    expect(runRequests()[0]?.json).toMatchObject({ duration: 12 });
    expect(result.warnings).toMatchObject([{ type: 'compatibility', feature: 'duration' }]);
  });

  it('sends the start image as a file and the end frame to its own input', async () => {
    const { wiro, runRequests } = setup();
    await generateVideo({
      model: wiro.video('bytedance/seedance-pro-v1-5'),
      prompt: { image: PNG_BYTES, text: 'Zoom in slowly' },
      frameImages: [
        { image: PNG_BYTES, frameType: 'first_frame' },
        { image: 'https://example.com/last.png', frameType: 'last_frame' },
      ],
      aspectRatio: 'adaptive',
      poll,
      download,
    });
    expect(runRequests()[0]?.form).toEqual([
      ['prompt', 'Zoom in slowly'],
      ['ratio', 'adaptive'],
      ['resolution', '480p'],
      ['duration', '5'],
      ['inputImage', { name: 'input-1.png', type: 'image/png', size: PNG_BYTES.byteLength }],
      ['inputImageLast', 'https://example.com/last.png'],
    ]);
  });

  it('routes image and video references to their inputs', async () => {
    const { wiro, runRequests } = setup();
    await generateVideo({
      model: wiro.video('bytedance/seedance-2-0-mini'),
      prompt: 'A dancer',
      inputReferences: [
        'https://example.com/style.png',
        { data: 'https://example.com/motion.mp4', mediaType: 'video/mp4' },
      ],
      poll,
      download,
    });
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'A dancer',
      inputImageReference: ['https://example.com/style.png'],
      inputVideoReference: ['https://example.com/motion.mp4'],
    });
  });

  it('warns about settings the model does not have', async () => {
    const { wiro } = setup();
    const result = await generateVideo({
      model: wiro.video('klingai/kling-v2-5-turbo'),
      prompt: 'A fox',
      fps: 30,
      generateAudio: true,
      poll,
      download,
    });
    expect(result.warnings).toEqual([
      {
        type: 'unsupported',
        feature: 'fps',
        details: 'klingai/kling-v2-5-turbo has no fps setting.',
      },
      {
        type: 'unsupported',
        feature: 'generateAudio',
        details: 'klingai/kling-v2-5-turbo has no audio setting.',
      },
    ]);
  });

  it('fails with a fixed message when the task fails', async () => {
    const { wiro } = setup({
      tasks: [finishedTask({ id: '401', pexit: '2', debugerror: 'stack trace' })],
    });
    await expect(
      generateVideo({
        model: wiro.video('klingai/kling-v2-5-turbo'),
        prompt: 'A fox',
        poll,
        download,
      }),
    ).rejects.toThrow(
      'Wiro task 401 for klingai/kling-v2-5-turbo failed. Check the prompt and settings, or try another model.',
    );
  });

  it('passes a webhook URL to Wiro as callbackUrl', async () => {
    const { wiro, runRequests } = setup({
      tasks: [finishedTask({ outputs: [output(VIDEO_URL, 'video/mp4')] })],
    });
    await generateVideo({
      model: wiro.video('klingai/kling-v2-5-turbo'),
      prompt: 'A fox',
      webhook: async () => ({
        url: 'https://example.com/hooks/video',
        received: Promise.resolve({ headers: {}, body: {} }),
      }),
      download,
    });
    expect(runRequests()[0]?.json).toMatchObject({
      callbackUrl: 'https://example.com/hooks/video',
    });
  });
});

describe('experimental_startVideo and experimental_getVideoStatus', () => {
  it('returns a task reference that can be checked later', async () => {
    const { wiro } = setup({
      tasks: [
        runningTask('task_start'),
        finishedTask({ outputs: [output(VIDEO_URL, 'video/mp4')] }),
      ],
    });
    const model = wiro.video('klingai/kling-v2-5-turbo');

    const started = await startVideo({ model, prompt: 'A fox' });
    expect(started.operation).toEqual({ taskId: '100', taskToken: 'token-100' });
    expect(started.providerMetadata?.wiro).toEqual({ taskId: '100' });

    expect(await getVideoStatus(model, { operation: started.operation })).toMatchObject({
      status: 'pending',
      providerMetadata: { wiro: { taskId: '100' } },
    });
    expect(await getVideoStatus(model, { operation: started.operation })).toMatchObject({
      status: 'completed',
      videos: [{ type: 'url', url: VIDEO_URL, mediaType: 'video/mp4' }],
      providerMetadata: { wiro: { taskId: '100', cost: 0.005 } },
    });
  });

  it('reports a cancelled task as an error status', async () => {
    const { wiro } = setup({ tasks: [finishedTask({ status: 'task_cancel', pexit: '' })] });
    const status = await getVideoStatus(wiro.video('klingai/kling-v2-5-turbo'), {
      operation: { taskId: '100' },
    });
    expect(status).toMatchObject({
      status: 'error',
      error: 'Wiro task 100 for klingai/kling-v2-5-turbo was cancelled.',
    });
  });
});
