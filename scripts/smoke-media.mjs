// Live check of the built package's image, speech, transcription and video
// models against the Wiro Run API. It is not part of CI, and every task is
// billed to the project behind WIRO_API_KEY (about 0.03 USD in all).
//
//   npm run build
//   WIRO_API_KEY=your-api-key node scripts/smoke-media.mjs
//
// It runs four tasks on low-cost models: an image on pruna/p-image, speech
// on wiro/kokoro-tts, a transcript of that speech on openai/whisper-large-v3
// and a one-second draft video on pruna/p-video. Each result has to name its
// task and cost in providerMetadata.wiro. Retries are off, and a fifth run is
// refused before it is sent. The key is only read by the provider and is
// never printed.

import {
  generateImage,
  generateSpeech,
  experimental_generateVideo as generateVideo,
  transcribe,
} from 'ai';
import { createWiro } from '../dist/index.js';

const MAX_RUNS = 4;

let runs = 0;
const countingFetch = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path.includes('/Run/')) {
    if (runs >= MAX_RUNS) {
      throw new Error(`Refusing run ${runs + 1}: the smoke test allows ${MAX_RUNS}.`);
    }
    runs += 1;
    console.log(`  run ${runs}: POST ${path}`);
  }
  return fetch(url, init);
};

const wiro = createWiro({ fetch: countingFetch });
const costs = [];
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function recordTask(label, metadata) {
  check(
    `${label} names its task`,
    typeof metadata?.taskId === 'string' && metadata.taskId !== '',
    metadata?.taskId,
  );
  check(`${label} has a cost`, typeof metadata?.cost === 'number', `${metadata?.cost} USD`);
  if (typeof metadata?.cost === 'number') costs.push(metadata.cost);
}

async function run(label, test) {
  console.log(`\n${label}`);
  try {
    await test();
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${error?.name}: ${error?.message}`);
    if (error?.taskId) console.log(`  task ${error.taskId}`);
  }
}

let speech;

await run('1. generateImage on pruna/p-image', async () => {
  const result = await generateImage({
    model: wiro.image('pruna/p-image'),
    prompt: 'A small red lighthouse on a rocky coast at dusk',
    aspectRatio: '1:1',
    maxRetries: 0,
  });
  check('an image came back', result.image.uint8Array.byteLength > 1000, result.image.mediaType);
  check('no warnings', result.warnings.length === 0, JSON.stringify(result.warnings));
  recordTask('the image', result.providerMetadata.wiro?.images?.[0]);
});

await run('2. generateSpeech on wiro/kokoro-tts', async () => {
  const result = await generateSpeech({
    model: wiro.speech('wiro/kokoro-tts'),
    text: 'Hello from Wiro AI. This is a quick test.',
    voice: 'nova',
    language: 'en',
    maxRetries: 0,
  });
  speech = result.audio.uint8Array;
  check('audio came back', speech.byteLength > 1000, result.audio.mediaType);
  recordTask('the speech', result.providerMetadata.wiro);
});

await run('3. transcribe on openai/whisper-large-v3', async () => {
  if (!speech) throw new Error('No speech to transcribe.');
  const result = await transcribe({
    model: wiro.transcription('openai/whisper-large-v3'),
    audio: speech,
    maxRetries: 0,
  });
  console.log(`  text: ${result.text}`);
  check('the transcript has the words', /quick test/i.test(result.text));
  recordTask('the transcript', result.providerMetadata.wiro);
});

await run('4. experimental_generateVideo on pruna/p-video', async () => {
  const result = await generateVideo({
    model: wiro.video('pruna/p-video'),
    prompt: 'Ocean waves rolling onto a sandy beach at sunset',
    aspectRatio: '16:9',
    duration: 1,
    providerOptions: { wiro: { draft: 'true' } },
    maxRetries: 0,
  });
  check('a video came back', result.video.uint8Array.byteLength > 1000, result.video.mediaType);
  recordTask('the video', result.providerMetadata.wiro?.videos?.[0]);
});

const total = costs.reduce((sum, cost) => sum + cost, 0);
console.log(`\ntotal: ${total.toFixed(6)} USD over ${runs} tasks`);
console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
