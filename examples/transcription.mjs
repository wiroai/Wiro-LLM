// Speech to text with the Wiro provider for the AI SDK. Pass a local audio
// file, or an https URL that Wiro downloads itself.
//
//   npm install @wiro-ai/wiro-llm ai
//   WIRO_API_KEY=your-api-key node transcription.mjs hello.mp3

import { readFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { transcribe } from 'ai';

const input = process.argv[2];
if (!input) throw new Error('Pass an audio file or URL: node transcription.mjs hello.mp3');

const { text, segments, providerMetadata } = await transcribe({
  model: wiro.transcription('openai/whisper-large-v3'),
  audio: /^https?:\/\//.test(input) ? new URL(input) : await readFile(input),
});

console.log(text);
for (const segment of segments) {
  console.log(`${segment.startSecond}s to ${segment.endSecond}s: ${segment.text}`);
}

const { taskId, cost } = providerMetadata.wiro;
console.log(`Wiro task ${taskId}, cost ${cost} USD.`);
