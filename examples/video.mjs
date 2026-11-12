// Video with the Wiro provider for the AI SDK: from text, or from a start
// image when you pass its path.
//
//   npm install @wiro-ai/wiro-llm ai
//   WIRO_API_KEY=your-api-key node video.mjs
//   WIRO_API_KEY=your-api-key node video.mjs lighthouse.jpeg

import { readFile, writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { experimental_generateVideo as generateVideo } from 'ai';

const startImage = process.argv[2];

const { video, providerMetadata } = await generateVideo({
  model: wiro.video('bytedance/seedance-v1-pro-fast'),
  prompt: startImage
    ? { image: await readFile(startImage), text: 'Slow push in, gentle waves, the light glows' }
    : 'A paper boat drifting on a calm pond, soft morning light',
  resolution: '864x480',
  duration: 5,
});

await writeFile('video.mp4', video.uint8Array);

const { taskId, cost } = providerMetadata.wiro.videos[0];
console.log(`Saved video.mp4. Wiro task ${taskId}, cost ${cost} USD.`);
