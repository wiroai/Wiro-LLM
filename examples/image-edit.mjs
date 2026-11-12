// Image editing with the Wiro provider for the AI SDK. The picture is
// uploaded with the run; a public URL works in its place too.
//
//   npm install @wiro-ai/wiro-llm ai
//   WIRO_API_KEY=your-api-key node image-edit.mjs photo.jpg

import { readFile, writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { generateImage } from 'ai';

const input = process.argv[2];
if (!input) throw new Error('Pass the path of a picture: node image-edit.mjs photo.jpg');

const { image, providerMetadata } = await generateImage({
  model: wiro.image('google/nano-banana'),
  prompt: {
    text: 'Turn this photo into a soft watercolor painting',
    images: [await readFile(input)],
  },
});

const file = `watercolor.${image.mediaType.split('/')[1]}`;
await writeFile(file, image.uint8Array);

const { taskId, cost } = providerMetadata.wiro.images[0];
console.log(`Saved ${file}. Wiro task ${taskId}, cost ${cost} USD.`);
