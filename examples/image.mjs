// Text to image with the Wiro provider for the AI SDK.
//
//   npm install @wiro-ai/wiro-llm ai
//   WIRO_API_KEY=your-api-key node image.mjs

import { writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { generateImage } from 'ai';

const { image, warnings, providerMetadata } = await generateImage({
  model: wiro.image('pruna/p-image'),
  prompt: 'A red lighthouse on a rocky coast at dusk, warm light in the windows',
  aspectRatio: '16:9',
  seed: 42,
});

const file = `lighthouse.${image.mediaType.split('/')[1]}`;
await writeFile(file, image.uint8Array);

const { taskId, cost } = providerMetadata.wiro.images[0];
console.log(`Saved ${file}. Wiro task ${taskId}, cost ${cost} USD.`);
if (warnings.length > 0) console.log(warnings);
