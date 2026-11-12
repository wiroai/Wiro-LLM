import { transcribe } from 'ai';
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
import {
  transcriptFromCaptions,
  transcriptFromJson,
  transcriptFromTimedLines,
  type WiroTranscriptionModel,
} from './wiro-transcription-model';

const CDN = 'https://cdn1.wiro.ai/files';

const WHISPER = tool('openai/whisper-large-v3', [
  param('inputAudio', 'combinefileinput', { required: true }),
  param('language', 'select', {
    required: true,
    defaultvalue: 'auto',
    options: ['auto', 'English'],
  }),
  param('chunkLength', 'number', { required: true, defaultvalue: '30' }),
  param('diarization', 'checkbox', { value: 'true' }),
]);

const ELEVEN_STT = tool('elevenlabs/speech-to-text', [
  param('inputAudio', 'fileinput', { required: true }),
  param('inputAudioUrl', 'text'),
]);

const PARAKEET = tool('nvidia/parakeet-tdt-0-6b-v3', [
  param('inputAudio', 'combinefileinput'),
  param('timestamps', 'select', {
    required: true,
    defaultvalue: 'false',
    options: ['false', 'true'],
  }),
  param('batchSize', 'number', { defaultvalue: '8' }),
]);

// The shape Parakeet writes, trimmed.
const PARAKEET_JSON = {
  index: 0,
  text: 'Hello from Wiro AI. This sentence was turned into speech.',
  timestamp: {
    word: [
      { word: 'Hello', start: 0, end: 0.4 },
      { word: 'from', start: 0.4, end: 0.64 },
    ],
    segment: [
      { segment: 'Hello from Wiro AI.', start: 0, end: 2 },
      { segment: 'This sentence was turned into speech.', start: 2.24, end: 5.2 },
    ],
  },
};

function setup(options: MockWiroOptions = {}) {
  const mock = createMockWiro({
    tools: {
      'openai/whisper-large-v3': WHISPER,
      'elevenlabs/speech-to-text': ELEVEN_STT,
      'nvidia/parakeet-tdt-0-6b-v3': PARAKEET,
    },
    tasks: [
      finishedTask({
        id: '300',
        totalcost: '0.0006',
        chargedcost: '0.0006',
        outputs: [output(`${CDN}/out.txt`, 'text/plain')],
      }),
    ],
    files: {
      [`${CDN}/out.txt`]: { body: 'Hello from Wiro AI.', contentType: 'text/plain' },
      [`${CDN}/0.json`]: { body: JSON.stringify(PARAKEET_JSON), contentType: 'application/json' },
      [`${CDN}/whisper.txt`]: {
        body: '00:00.0 - 00:02.1 /  Hello from Wiro AI.\n00:02.1 - 00:05.3 /  This is a test.\n',
        contentType: 'text/plain',
      },
    },
    ...options,
  });
  return {
    ...mock,
    wiro: createWiro({ apiKey: 'test-key', fetch: mock.fetch, poll: { intervalMs: 0 } }),
  };
}

describe('transcribe', () => {
  it('uploads audio bytes and reads a text transcript', async () => {
    const { wiro, runRequests } = setup();

    const result = await transcribe({
      model: wiro.transcription('openai/whisper-large-v3'),
      audio: MP3_BYTES,
    });

    expect(result.text).toBe('Hello from Wiro AI.');
    expect(runRequests()[0]?.form).toEqual([
      ['language', 'auto'],
      ['chunkLength', '30'],
      ['inputAudio', { name: 'input-1.mp3', type: 'audio/mpeg', size: MP3_BYTES.byteLength }],
    ]);
    expect(result.providerMetadata.wiro).toEqual({
      taskId: '300',
      cost: 0.0006,
      elapsedSeconds: 6,
    });
  });

  it('sends the file and an empty Url field to a single file input', async () => {
    const { wiro, runRequests } = setup();
    await transcribe({ model: wiro.transcription('elevenlabs/speech-to-text'), audio: MP3_BYTES });
    expect(runRequests()[0]?.form).toEqual([
      ['inputAudio', { name: 'input-1.mp3', type: 'audio/mpeg', size: MP3_BYTES.byteLength }],
      ['inputAudioUrl', ''],
    ]);
  });

  it('lets Wiro download a public audio URL itself', async () => {
    const { wiro, runRequests } = setup();
    await transcribe({
      model: wiro.transcription('elevenlabs/speech-to-text'),
      audio: new URL('https://example.com/talk.mp3'),
    });
    expect(runRequests()[0]?.json).toEqual({ inputAudioUrl: 'https://example.com/talk.mp3' });
  });

  it('leaves URLs Wiro cannot reach to the AI SDK', async () => {
    const { wiro } = setup();
    const model = wiro.transcription('elevenlabs/speech-to-text') as WiroTranscriptionModel;
    await expect(
      model.doGenerateFromUrl({ audio: new URL('http://localhost:3000/talk.mp3') }),
    ).resolves.toBeUndefined();
  });

  it('reads timings from a JSON transcript and turns on timestamps', async () => {
    const { wiro, runRequests } = setup({
      tasks: [
        finishedTask({
          outputs: [
            output(`${CDN}/out.txt`, 'text/plain'),
            output(`${CDN}/0.json`, 'application/json'),
          ],
        }),
      ],
    });

    const result = await transcribe({
      model: wiro.transcription('nvidia/parakeet-tdt-0-6b-v3'),
      audio: MP3_BYTES,
      timestampGranularities: ['segment'],
    });

    expect(runRequests()[0]?.form?.[0]).toEqual(['timestamps', 'true']);
    expect(result.text).toBe(PARAKEET_JSON.text);
    expect(result.segments).toEqual([
      { text: 'Hello from Wiro AI.', startSecond: 0, endSecond: 2 },
      { text: 'This sentence was turned into speech.', startSecond: 2.24, endSecond: 5.2 },
    ]);
    expect(result.durationInSeconds).toBe(5.2);
  });

  it('reads Whisper lines with their time spans', async () => {
    const { wiro } = setup({
      tasks: [finishedTask({ outputs: [output(`${CDN}/whisper.txt`, 'text/plain')] })],
    });
    const result = await transcribe({
      model: wiro.transcription('openai/whisper-large-v3'),
      audio: MP3_BYTES,
    });
    expect(result.text).toBe('Hello from Wiro AI. This is a test.');
    expect(result.segments).toEqual([
      { text: 'Hello from Wiro AI.', startSecond: 0, endSecond: 2.1 },
      { text: 'This is a test.', startSecond: 2.1, endSecond: 5.3 },
    ]);
  });

  it('warns when the model has no timestamp setting', async () => {
    const { wiro } = setup();
    const result = await transcribe({
      model: wiro.transcription('elevenlabs/speech-to-text'),
      audio: MP3_BYTES,
      timestampGranularities: ['word'],
    });
    expect(result.warnings).toMatchObject([
      { type: 'unsupported', feature: 'timestampGranularities' },
    ]);
  });

  it('does not take the model log for a transcript', async () => {
    const { wiro } = setup({
      tasks: [
        finishedTask({
          outputs: [],
          debugoutput: '100%|██████████| 1/1 [00:00<00:00]\nTranscribing...',
        }),
      ],
    });
    await expect(
      transcribe({ model: wiro.transcription('openai/whisper-large-v3'), audio: MP3_BYTES }),
    ).rejects.toMatchObject({ reason: 'no-output' });
  });
});

describe('transcript formats', () => {
  it('reads OpenAI-style segments with a language and duration', () => {
    expect(
      transcriptFromJson({
        text: ' Hi there. ',
        language: 'en',
        duration: 3.5,
        segments: [{ text: 'Hi there.', start: 0, end: 3.5 }],
      }),
    ).toEqual({
      text: 'Hi there.',
      segments: [{ text: 'Hi there.', startSecond: 0, endSecond: 3.5 }],
      language: 'en',
      durationInSeconds: 3.5,
    });
  });

  it('reads Hugging Face chunks', () => {
    expect(
      transcriptFromJson({
        chunks: [
          { text: 'One.', timestamp: [0, 1] },
          { text: 'Two.', timestamp: [1, 2] },
        ],
      })?.text,
    ).toBe('One. Two.');
  });

  it('reads SubRip captions', () => {
    const srt =
      '1\n00:00:00,000 --> 00:00:01,500\nHello there.\n\n2\n00:00:01,500 --> 00:00:03,000\nSee you soon.\n';
    expect(transcriptFromCaptions(srt)).toEqual({
      text: 'Hello there. See you soon.',
      segments: [
        { text: 'Hello there.', startSecond: 0, endSecond: 1.5 },
        { text: 'See you soon.', startSecond: 1.5, endSecond: 3 },
      ],
      language: undefined,
      durationInSeconds: 3,
    });
  });

  it('only reads timed lines when every line has a time span', () => {
    expect(transcriptFromTimedLines('Just a sentence.')).toBeUndefined();
    expect(transcriptFromTimedLines('00:01.0 - 00:02.0 / Yes.\nno time here')).toBeUndefined();
  });
});
