// Text to speech with the Wiro provider for the AI SDK.
//
//   npm install @wiro-ai/wiro-llm ai
//   WIRO_API_KEY=your-api-key node speech.mjs

import { writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { generateSpeech } from 'ai';

const { audio, providerMetadata } = await generateSpeech({
  model: wiro.speech('elevenlabs/eleven-v4-turbo'),
  text: 'Hello from Wiro AI. This sentence was turned into speech.',
  voice: 'alice',
  language: 'en',
  outputFormat: 'mp3',
});

await writeFile('hello.mp3', audio.uint8Array);

const { taskId, cost } = providerMetadata.wiro;
console.log(`Saved hello.mp3. Wiro task ${taskId}, cost ${cost} USD.`);
