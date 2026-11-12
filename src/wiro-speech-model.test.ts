import { generateSpeech } from 'ai';
import { describe, expect, it } from 'vitest';
import { createWiro } from './index';
import {
  createMockWiro,
  finishedTask,
  type MockWiroOptions,
  MP3_BYTES,
  output,
  param,
  tool,
} from './test-helpers/mock-wiro';

const AUDIO_URL = 'https://cdn1.wiro.ai/files/output.mp3';

const ELEVEN = tool('elevenlabs/eleven-v4-turbo', [
  param('prompt', 'textarea', { required: true }),
  param('voice', 'select', {
    required: true,
    defaultvalue: 'alice',
    options: [
      { value: 'adam', text: 'Adam' },
      { value: 'alice', text: 'Alice' },
    ],
  }),
  param('outputFormat', 'select', {
    required: true,
    defaultvalue: 'mp3_44100_128',
    options: ['mp3_22050_32', 'mp3_44100_64', 'mp3_44100_128'],
  }),
  param('languageCode', 'select', {
    defaultvalue: 'auto',
    options: [
      { value: 'auto', text: 'Auto' },
      { value: 'en', text: 'English' },
      { value: 'tr', text: 'Turkish' },
    ],
  }),
  param('stability', 'float', { defaultvalue: '0.5', minvalue: '0', maxvalue: '1' }),
]);

const KOKORO = tool('wiro/kokoro-tts', [
  param('prompt', 'textarea'),
  param('voice', 'select', {
    required: true,
    defaultvalue: 'af_heart',
    options: [
      { value: 'af_heart', text: 'Heart' },
      { value: 'af_nova', text: 'Nova' },
    ],
  }),
  param('langCode', 'select', {
    required: true,
    defaultvalue: 'a',
    options: [
      { value: 'a', text: 'American English' },
      { value: 'b', text: 'British English' },
      { value: 'e', text: 'Spanish' },
    ],
  }),
]);

const QWEN = tool('qwen/qwen3-tts-12hz-1-7b', [
  param('prompt', 'textarea'),
  param('instruction', 'textarea', { defaultvalue: 'Excited' }),
  param('language', 'select', {
    required: true,
    defaultvalue: 'Auto',
    options: ['auto', 'english'],
  }),
  param('speaker', 'select', {
    required: true,
    defaultvalue: 'Aiden',
    options: ['aiden', 'serena'],
  }),
  param('speed', 'float', { defaultvalue: '1', minvalue: '0.5', maxvalue: '2' }),
]);

function setup(options: MockWiroOptions = {}) {
  const mock = createMockWiro({
    tools: {
      'elevenlabs/eleven-v4-turbo': ELEVEN,
      'wiro/kokoro-tts': KOKORO,
      'qwen/qwen3-tts-12hz-1-7b': QWEN,
    },
    tasks: [
      finishedTask({
        id: '200',
        totalcost: '0.00296',
        chargedcost: '0.00296',
        outputs: [output(AUDIO_URL, 'audio/mpeg')],
      }),
    ],
    files: { [AUDIO_URL]: { body: MP3_BYTES, contentType: 'audio/mpeg' } },
    ...options,
  });
  return {
    ...mock,
    wiro: createWiro({ apiKey: 'test-key', fetch: mock.fetch, poll: { intervalMs: 0 } }),
  };
}

describe('generateSpeech', () => {
  it('sends the text, voice, language and format, and returns the audio with its cost', async () => {
    const { wiro, runRequests } = setup();

    const result = await generateSpeech({
      model: wiro.speech('elevenlabs/eleven-v4-turbo'),
      text: 'Hello from Wiro AI.',
      voice: 'Adam',
      language: 'tr',
      outputFormat: 'mp3',
    });

    expect(runRequests()[0]?.url).toBe('https://api.wiro.ai/v1/Run/elevenlabs/eleven-v4-turbo');
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'Hello from Wiro AI.',
      voice: 'adam',
      languageCode: 'tr',
      outputFormat: 'mp3_44100_128',
    });
    expect(result.audio.uint8Array).toEqual(MP3_BYTES);
    expect(result.audio.mediaType).toBe('audio/mpeg');
    expect(result.warnings).toEqual([]);
    expect(result.providerMetadata.wiro).toEqual({
      taskId: '200',
      cost: 0.00296,
      elapsedSeconds: 6,
      url: AUDIO_URL,
      mediaType: 'audio/mpeg',
    });
  });

  it('matches voices by label and languages by name', async () => {
    const { wiro, runRequests } = setup();
    await generateSpeech({
      model: wiro.speech('wiro/kokoro-tts'),
      text: 'Hi',
      voice: 'nova',
      language: 'en-GB',
    });
    expect(runRequests()[0]?.json).toEqual({ prompt: 'Hi', voice: 'af_nova', langCode: 'b' });
  });

  it('sends instructions and speed to models that take them', async () => {
    const { wiro, runRequests } = setup();
    await generateSpeech({
      model: wiro.speech('qwen/qwen3-tts-12hz-1-7b'),
      text: 'Hi',
      instructions: 'Calm and slow',
      speed: 0.9,
      voice: 'serena',
    });
    expect(runRequests()[0]?.json).toEqual({
      prompt: 'Hi',
      instruction: 'Calm and slow',
      speed: 0.9,
      speaker: 'serena',
      language: 'auto',
    });
  });

  it('warns about settings the model does not have or values it does not offer', async () => {
    const { wiro, runRequests } = setup();
    const result = await generateSpeech({
      model: wiro.speech('wiro/kokoro-tts'),
      text: 'Hi',
      voice: 'alloy',
      speed: 1.2,
    });
    expect(runRequests()[0]?.json).toEqual({ prompt: 'Hi', voice: 'af_heart', langCode: 'a' });
    expect(result.warnings).toEqual([
      {
        type: 'unsupported',
        feature: 'voice',
        details: 'wiro/kokoro-tts has no voice "alloy". It offers af_heart, af_nova.',
      },
      { type: 'unsupported', feature: 'speed', details: 'wiro/kokoro-tts has no speed setting.' },
    ]);
  });

  it('passes providerOptions.wiro settings to the model', async () => {
    const { wiro, runRequests } = setup();
    await generateSpeech({
      model: wiro.speech('elevenlabs/eleven-v4-turbo'),
      text: 'Hi',
      providerOptions: { wiro: { stability: 0.3, voice: 'alice' } },
    });
    expect(runRequests()[0]?.json).toMatchObject({ stability: 0.3, voice: 'alice' });
  });

  it('reports a task without audio', async () => {
    const { wiro } = setup({ tasks: [finishedTask({ outputs: [] })] });
    await expect(
      generateSpeech({ model: wiro.speech('wiro/kokoro-tts'), text: 'Hi' }),
    ).rejects.toMatchObject({ reason: 'no-output', taskId: '100' });
  });
});
