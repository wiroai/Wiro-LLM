<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/Wiro-Plugin/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro AI provider for the AI SDK

Use Wiro AI models from the Vercel AI SDK: chat on the Wiro LLM gateway, plus image, speech, transcription and video models, and see what each call cost.

[![npm](https://img.shields.io/npm/v/@wiro-ai/wiro-llm?style=for-the-badge&color=111111)](https://www.npmjs.com/package/@wiro-ai/wiro-llm) [![AI SDK 7](https://img.shields.io/badge/AI%20SDK-7-111111?style=for-the-badge&color=111111)](https://ai-sdk.dev) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-111111?style=for-the-badge&color=111111)](#install) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge&color=111111)](./LICENSE)

[Website](https://wiro.ai) · [LLM gateway](https://wiro.ai/llm) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [Dashboard](https://wiro.ai/panel)

</div>

Wiro AI runs 1,000+ AI models behind one API and one project key. `@wiro-ai/wiro-llm` brings them into the [AI SDK](https://ai-sdk.dev):

- **Chat** on the [Wiro LLM gateway](https://wiro.ai/llm), with models from OpenAI, Anthropic, Google, xAI, DeepSeek, Qwen and others: `generateText` and `streamText` with tools, structured output and reasoning settings.
- **Images** with `generateImage`: text to image, and image editing from your own pictures.
- **Speech** with `generateSpeech`: text-to-speech models and their voices.
- **Transcription** with `transcribe`: speech-to-text models, with timings when the model gives them.
- **Video** with `experimental_generateVideo`: text to video, or video from a start image.

Chat calls go to the gateway's OpenAI-compatible endpoint, `https://llm.wiro.ai/v1`. Image, speech, transcription and video calls go to the Wiro [Run API](https://wiro.ai/docs/run-a-model): the provider starts a task, waits for it and downloads the result. Every result tells you what the call cost, in `providerMetadata.wiro`, and calls are paid from your Wiro wallet.

## Install

```bash
npm install @wiro-ai/wiro-llm ai zod
```

The package needs Node.js 22 or later, the same as AI SDK 7. `zod` is used for tool inputs and structured output.

Create a project at [wiro.ai/panel/project/new](https://wiro.ai/panel/project/new) and put its credential in `WIRO_API_KEY`: the API key for an API Key Only project, or `API_KEY:API_SECRET` (both values joined with a colon) for a Signature project. For a Signature project, image, speech, transcription and video calls sign every request with the secret, and the secret itself is never sent. Call Wiro from server code so the key never reaches a browser.

```bash
export WIRO_API_KEY=your-api-key
```

## Quick start

```js
import { wiro } from '@wiro-ai/wiro-llm';
import { generateText } from 'ai';

const { text } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  prompt: 'Explain what an API gateway does in one sentence.',
});

console.log(text);
```

`wiro(modelId)`, `wiro.chatModel(modelId)` and `wiro.languageModel(modelId)` return the same chat model. On reasoning models, `maxOutputTokens` covers the reasoning as well as the answer, so leave room if you set it. If a reply comes back empty with `finishReason` `length`, raise it or lower the reasoning effort.

### Settings

`createWiro()` makes a provider with your own settings. The default `wiro` instance is `createWiro()` with no options.

```js
import { createWiro } from '@wiro-ai/wiro-llm';

const wiro = createWiro({
  apiKey: process.env.MY_WIRO_KEY,
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `apiKey` | `WIRO_API_KEY` | Your project credential. Use `API_KEY:API_SECRET` for a Signature project. |
| `baseURL` | `https://llm.wiro.ai/v1` | The LLM gateway URL, for chat models. |
| `runBaseURL` | `https://api.wiro.ai/v1` | The Run API URL, for image, speech, transcription and video models. |
| `poll` | see [Tasks](#tasks-costs-and-errors) | How image, speech and transcription calls wait for their task: `intervalMs` between checks and `timeoutMs` in all. |
| `headers` | none | Extra headers to send with every request. |
| `fetch` | `globalThis.fetch` | Your own fetch function, for example to log requests or in tests. |

The key is read when a request is made, so importing `wiro` before `WIRO_API_KEY` is set is fine.

## Streaming

```js
import { streamText } from 'ai';

const result = streamText({
  model: wiro('deepseek/v4-1-flash'),
  prompt: 'Write a two-line poem about routing requests.',
});

for await (const part of result.textStream) {
  process.stdout.write(part);
}

console.log(await result.usage);
```

When a model thinks before it answers, its reasoning comes separately in `reasoningText`, and the token counts arrive at the end of the stream.

## Tools

The model calls a tool, the AI SDK runs `execute` and sends the result back, and the model writes the answer. `stopWhen` caps the number of steps.

```js
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';

const { text } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  tools: {
    getWeather: tool({
      description: 'Get the current weather for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperatureC: 21 }),
    }),
  },
  stopWhen: isStepCount(3),
  prompt: 'What is the weather in Istanbul right now?',
});
```

## Structured output

```js
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  output: Output.object({
    schema: z.object({ name: z.string(), country: z.string(), population: z.number() }),
  }),
  prompt: 'Give me the largest city in Turkey.',
});
```

The schema goes to the model as `response_format` of type `json_schema`. [`GET /v1/models`](https://wiro.ai/docs/completions-api) lists the structured output modes of each model under `capabilities.structured_output_modes`.

## Reasoning effort

`providerOptions.wiro.reasoningEffort` is sent as `reasoning_effort`:

```js
const { text } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  providerOptions: { wiro: { reasoningEffort: 'low' } },
  prompt: 'Is 97 a prime number? Answer yes or no.',
});
```

Use it with models that list `reasoning_effort` in their `supported_parameters`. The AI SDK's own `reasoning` option, such as `reasoning: 'low'`, sends the same field. Keys under `providerOptions.wiro` that the AI SDK does not know, such as `parallel_tool_calls: false`, are added to the request body as they are.

## Cost

Each response carries the amount the call was billed, in USD, and the provider puts it in `providerMetadata.wiro.cost`:

```js
const result = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  prompt: 'Explain what an API gateway does in one sentence.',
});

console.log(result.providerMetadata?.wiro?.cost); // for example 0.0000482
```

With `streamText`, read it once the stream has finished: `(await result.providerMetadata)?.wiro?.cost`.

A call with tools can take several steps, and each step is a request with its own cost. Add them up for the total:

```js
const total = result.steps.reduce(
  (sum, step) => sum + Number(step.providerMetadata?.wiro?.cost ?? 0),
  0,
);
```

## Images

```js
import { writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { generateImage } from 'ai';

const { image, providerMetadata } = await generateImage({
  model: wiro.image('pruna/p-image'),
  prompt: 'A red lighthouse on a rocky coast at dusk, warm light in the windows',
  aspectRatio: '16:9',
  seed: 42,
});

await writeFile(`lighthouse.${image.mediaType.split('/')[1]}`, image.uint8Array);
console.log(providerMetadata.wiro.images[0]); // { taskId, cost, url, mediaType }
```

`wiro.image(modelId)` and `wiro.imageModel(modelId)` return the same image model. Models name their settings in different ways, such as `aspectRatio` or `ratio`, `samples` or `maxImages`, `width` and `height` or `resolution`. The provider reads each model's settings from Wiro once and sends `n`, `size`, `aspectRatio` and `seed` in the form that model takes: a size becomes a width and height, or an aspect ratio and the closest resolution, and an aspect ratio becomes a width and height on models that take those. A value the model does not offer comes back as a warning in `warnings`, and the model's default is used instead.

With `n` above 1, a model with an image count setting makes all the images in one task, and other models get one task per image.

### Image editing

Pass your pictures in `prompt.images` to a model that takes input images, such as `google/nano-banana`, `openai/gpt-image-2` or `wiro/flux-2-dev`:

```js
import { readFile } from 'node:fs/promises';

const { image } = await generateImage({
  model: wiro.image('google/nano-banana'),
  prompt: {
    text: 'Turn this photo into a soft watercolor painting',
    images: [await readFile('photo.jpg')],
  },
});
```

Images can be bytes, base64 text or URLs. Bytes are uploaded with the run, and URLs go to Wiro as they are, so they must be public. `prompt.mask` goes to models that take a mask, and a model without a prompt, such as `wiro/remove-background`, takes `prompt: { images: [...] }` alone.

### Model settings

Every model has settings of its own, listed on its page in the [model catalog](https://wiro.ai/models). Pass them in `providerOptions.wiro`; they go to the model as they are and win over the settings the provider fills in:

```js
await generateImage({
  model: wiro.image('openai/gpt-image-2'),
  prompt: 'A product photo of a ceramic mug on a linen tablecloth',
  aspectRatio: '3:2',
  providerOptions: { wiro: { quality: 'high', resolution: '2k' } },
});
```

Required settings you leave out get the default the model shows in the catalog. [Model parameters](https://wiro.ai/docs/model-parameters) explains the setting types.

## Speech

```js
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
console.log(providerMetadata.wiro); // { taskId, cost, elapsedSeconds, url, mediaType }
```

`voice` matches a model's voices by ID or by name, so `nova` picks `af_nova` on `wiro/kokoro-tts`. `language` takes ISO 639-1 codes such as `en` or `tr` and matches them to the model's own language list, whether it holds codes, names or letters. `outputFormat` picks the model's format of that kind (`mp3` gives `mp3_44100_128` on ElevenLabs models), and `instructions` and `speed` go to models that have them.

## Transcription

```js
import { readFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { transcribe } from 'ai';

const { text, segments, providerMetadata } = await transcribe({
  model: wiro.transcription('openai/whisper-large-v3'),
  audio: await readFile('meeting.mp3'),
});

console.log(text);
console.log(segments); // [{ text, startSecond, endSecond }, ...]
```

Audio can be bytes, base64 text or a URL. A public URL goes straight to Wiro, which downloads it, so a long recording never passes through your server:

```js
await transcribe({
  model: wiro.transcription('elevenlabs/speech-to-text'),
  audio: new URL('https://example.com/interview.mp3'),
});
```

`segments` holds the timings a model writes, and `timestampGranularities: ['segment']` turns them on for models with a timestamp setting, such as `nvidia/parakeet-tdt-0-6b-v3`. Language and speaker settings go in `providerOptions.wiro`, for example `{ language: 'English', numSpeakers: 2 }` on `openai/whisper-large-v3`.

## Video

```js
import { writeFile } from 'node:fs/promises';
import { wiro } from '@wiro-ai/wiro-llm';
import { experimental_generateVideo as generateVideo } from 'ai';

const { video, providerMetadata } = await generateVideo({
  model: wiro.video('bytedance/seedance-v1-pro-fast'),
  prompt: 'A paper boat drifting on a calm pond, soft morning light',
  resolution: '864x480',
  duration: 5,
});

await writeFile('boat.mp4', video.uint8Array);
console.log(providerMetadata.wiro.videos[0]); // { taskId, cost, url, mediaType }
```

A start image goes in `prompt: { image, text }`, and `frameImages` with a `last_frame` sets the end frame on models that take one. `aspectRatio`, `resolution`, `duration`, `fps`, `seed` and `generateAudio` go to the model's matching settings: `1280x720` becomes `720p`, and a duration the model does not offer becomes the closest one it does, with a warning. `inputReferences` go to models that take reference images or videos.

Video calls use the AI SDK's start and status flow. `poll` sets how often the SDK checks the task and how long it waits (every 5 seconds, up to 10 minutes, by default). With `webhook`, Wiro posts to your URL when the video is done, and the SDK waits for that instead of checking. To start a video in one process and collect it in another, use `experimental_startVideo` and `experimental_getVideoStatus`:

```js
import {
  experimental_getVideoStatus as getVideoStatus,
  experimental_startVideo as startVideo,
} from 'ai';

const model = wiro.video('klingai/kling-v2-5-turbo');
const { operation } = await startVideo({ model, prompt: 'A fox walking through fresh snow' });
// Store `operation` ({ taskId, taskToken }) and check it later:
const status = await getVideoStatus(model, { operation });
if (status.status === 'completed') console.log(status.videos[0].url);
```

## Tasks, costs and errors

Image, speech, transcription and video calls run as Wiro tasks, and each result names its task and what it cost, in USD:

| Call | Task and cost |
| --- | --- |
| `generateImage` | `providerMetadata.wiro.images[i]` has `taskId`, `cost` (the image's share of its task), `url` and `mediaType`. `calls[i].providerMetadata.wiro` has each task's `taskId`, `cost` and `elapsedSeconds`. |
| `generateSpeech` | `providerMetadata.wiro` has `taskId`, `cost`, `elapsedSeconds`, `url` and `mediaType`. |
| `transcribe` | `providerMetadata.wiro` has `taskId`, `cost` and `elapsedSeconds`. |
| `experimental_generateVideo` | `providerMetadata.wiro.videos[i]` has `taskId`, `cost`, `url` and `mediaType`. |

`url` is the file on Wiro's CDN, so you can hand a result to another model, such as an image to a video model, without uploading it again.

The provider checks a task every 2 seconds at first, then less often, and waits up to 10 minutes. `createWiro({ poll: { intervalMs, timeoutMs } })` changes both for image, speech and transcription calls. `abortSignal` ends the wait.

A task that ends without a result throws a `WiroTaskError` with the `taskId` and a `reason`: `failed`, `cancelled`, `timeout`, `no-output`, `status` or `download`. A run Wiro refuses, such as one without the prompt a model requires, throws an `APICallError` with Wiro's reason.

```js
import { WiroTaskError } from '@wiro-ai/wiro-llm';

try {
  await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A red lighthouse' });
} catch (error) {
  if (WiroTaskError.isInstance(error)) console.log(error.reason, error.taskId);
  else throw error;
}
```

## Models

Model IDs are lowercase `owner/model`, such as `openai/gpt-6-sol`, `claude/sonnet-5`, `google/gemini-3-pro`, `xai/grok-4-5`, `deepseek/v4-pro` or `qwen/qwen3-32b`. The `WiroChatModelId` type lists the models the gateway served when this version was published, so your editor can complete them, and any other ID works as well. Browse them in the [model catalog](https://wiro.ai/models?categories=llm-tool-call) or with `GET https://llm.wiro.ai/v1/models`, which also shows each model's tools, modalities and limits.

Image, speech, transcription and video models use the IDs of the [model catalog](https://wiro.ai/models): browse [text to image](https://wiro.ai/models?categories=text-to-image), [image editing](https://wiro.ai/models?categories=image-to-image), [text to speech](https://wiro.ai/models?categories=text-to-speech), [speech to text](https://wiro.ai/models?categories=speech-to-text), [text to video](https://wiro.ai/models?categories=text-to-video) and [image to video](https://wiro.ai/models?categories=image-to-video). `WiroImageModelId`, `WiroSpeechModelId`, `WiroTranscriptionModelId` and `WiroVideoModelId` list the catalog's models for autocomplete, and new models work without an update.

## Responses and Messages routes

Besides Chat Completions, which this package uses, the gateway serves OpenAI Responses at `/v1/responses` and Anthropic Messages at `/v1/messages`. The AI SDK's own providers reach them with the same base URL and key:

```js
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({
  baseURL: 'https://llm.wiro.ai/v1',
  apiKey: process.env.WIRO_API_KEY,
});

const anthropic = createAnthropic({
  baseURL: 'https://llm.wiro.ai/v1',
  apiKey: process.env.WIRO_API_KEY,
});

const viaResponses = openai.responses('openai/gpt-5-4-nano');
const viaMessages = anthropic('claude/sonnet-5');
```

`@ai-sdk/anthropic` caps the output at 4,096 tokens for model IDs it does not know, so pass `maxOutputTokens` for longer answers.

## Examples

[`examples/`](./examples) has a short, runnable file for each part of this package, and for the other SDKs the gateway works with:

| File | Shows |
| --- | --- |
| [`ai-sdk.mjs`](./examples/ai-sdk.mjs) | This package with `generateText` |
| [`image.mjs`](./examples/image.mjs) | `generateImage` with an aspect ratio and a seed |
| [`image-edit.mjs`](./examples/image-edit.mjs) | Image editing from a local picture |
| [`speech.mjs`](./examples/speech.mjs) | `generateSpeech` with a voice and a language |
| [`transcription.mjs`](./examples/transcription.mjs) | `transcribe` with timings |
| [`video.mjs`](./examples/video.mjs) | `experimental_generateVideo` from text, or from a start image |
| [`openai-sdk.mjs`](./examples/openai-sdk.mjs) | The OpenAI SDK for JavaScript |
| [`openai_sdk.py`](./examples/openai_sdk.py) | The OpenAI SDK for Python |
| [`anthropic-sdk.mjs`](./examples/anthropic-sdk.mjs) | The Anthropic SDK for JavaScript, on the Messages route |
| [`langchain.mjs`](./examples/langchain.mjs) | LangChain's `ChatOpenAI` with `configuration.baseURL` |
| [`llamaindex_llm.py`](./examples/llamaindex_llm.py) | LlamaIndex's `OpenAILike` |
| [`pydantic_ai_agent.py`](./examples/pydantic_ai_agent.py) | Pydantic AI with its OpenAI provider and `base_url` |

Each file starts with the commands to install and run it. `npm install` in `examples/` installs everything the JavaScript ones need.

## Documentation

- [Direct LLM Gateway](https://wiro.ai/docs/completions-api): routes, authentication, model discovery, usage and errors
- [AI SDK setup](https://wiro.ai/docs/completions-api#llm-setup-ai-sdk): the same setup with `@ai-sdk/openai-compatible`
- [Run a model](https://wiro.ai/docs/run-a-model) and [Tasks](https://wiro.ai/docs/tasks): the Run API behind image, speech, transcription and video calls
- [AI SDK documentation](https://ai-sdk.dev/docs/introduction): `generateText` and `streamText`, plus [image generation](https://ai-sdk.dev/docs/ai-sdk-core/image-generation), [speech](https://ai-sdk.dev/docs/ai-sdk-core/speech), [transcription](https://ai-sdk.dev/docs/ai-sdk-core/transcription) and [video generation](https://ai-sdk.dev/docs/ai-sdk-core/video-generation)

## Agent skill

This repository includes an agent skill, `wiro-llm`, in [`skills/wiro-llm/SKILL.md`](./skills/wiro-llm/SKILL.md). It shows coding agents such as Claude Code and Cursor how to call the Wiro LLM gateway: pick a model, use it from the OpenAI, Anthropic or AI SDK clients, and read what each call cost. Add it to your agent with:

```bash
npx skills add wiroai/Wiro-LLM --skill wiro-llm
```

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The tests use a mocked `fetch` and make no network calls. Two scripts check the built package against the live API, billed to the project behind `WIRO_API_KEY`, and are not part of CI. `scripts/smoke.mjs` makes five small chat calls on `openai/gpt-5-4-nano`, and `scripts/smoke-media.mjs` runs one image, one speech, one transcription and one video task on low-cost models:

```bash
npm run build
WIRO_API_KEY=your-api-key npm run smoke
WIRO_API_KEY=your-api-key npm run smoke:media
```

`node scripts/update-media-model-ids.mjs` refreshes the image, speech, transcription and video model ID lists from the public catalog.

## Support, terms and privacy

Email [support@wiro.ai](mailto:support@wiro.ai) or open an issue in this repository. Use of Wiro AI through this package is covered by the Wiro AI [Terms of Service](https://wiro.ai/agreement/terms-of-service) and [Privacy Policy](https://wiro.ai/agreement/privacy-policy).

## More from Wiro AI

| Repository | What it is |
| --- | --- |
| [Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin) | Wiro AI plugin for Cursor, Claude Code, Gemini CLI, Devin, Antigravity and Kiro |
| [Wiro-Skills](https://github.com/wiroai/Wiro-Skills) | Agent skills for images, image edits, video, music, speech, transcripts, 3D and model search |
| [Wiro-MCP](https://github.com/wiroai/Wiro-MCP) | Official MCP server for Wiro AI, [`@wiro-ai/wiro-mcp` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-mcp) |
| [Wiro-Chromium-Extension](https://github.com/wiroai/Wiro-Chromium-Extension) | Wiro AI extension for Chrome, Edge, Opera and Brave |
| [Wiro-Firefox-Extension](https://github.com/wiroai/Wiro-Firefox-Extension) | Wiro AI add-on for Firefox |
| [Wiro-Safari-Extension](https://github.com/wiroai/Wiro-Safari-Extension) | Wiro AI extension for Safari on the Mac |
| [Swift-QuickStart](https://github.com/wiroai/Swift-QuickStart) | WiroKit, the Wiro AI SDK for iOS |
| [Kotlin-QuickStart](https://github.com/wiroai/Kotlin-QuickStart) | WiroKit, the Wiro AI SDK for Android |
| [Dart-QuickStart](https://github.com/wiroai/Dart-QuickStart) | Wiro AI SDK for Dart and Flutter, [`wiro` on pub.dev](https://pub.dev/packages/wiro) |
| [ReactNative-QuickStart](https://github.com/wiroai/ReactNative-QuickStart) | Wiro AI SDK for React Native and Expo, [`@wiro-ai/wiro-react-native` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-react-native) |
| [Swift-Realtime](https://github.com/wiroai/Swift-Realtime) | Realtime voice AI example for iOS |
| [Kotlin-Realtime](https://github.com/wiroai/Kotlin-Realtime) | Realtime voice AI example for Android |
| [Dart-Realtime](https://github.com/wiroai/Dart-Realtime) | Realtime voice AI example for Flutter |
| [ReactNative-Realtime](https://github.com/wiroai/ReactNative-Realtime) | Realtime voice AI example for React Native |
| [n8n-nodes-wiro](https://github.com/wiroai/n8n-nodes-wiro) | One Wiro AI node for n8n with a searchable model picker, [`@wiro-ai/n8n-nodes-wiro` on npm](https://www.npmjs.com/package/@wiro-ai/n8n-nodes-wiro) |
| [Wiro-Dify-Plugin](https://github.com/wiroai/Wiro-Dify-Plugin) | Wiro AI plugins for Dify: the LLM gateway as a model provider, plus image, video, speech and music tools |
| [Wiro-ComfyUI](https://github.com/wiroai/Wiro-ComfyUI) | Wiro AI nodes for ComfyUI |
| [Wiro-Hermes](https://github.com/wiroai/Wiro-Hermes) | Wiro AI plugins for Hermes Agent: image, video, audio and 3D tools, plus the LLM gateway as a model provider |
| [Wiro-Zed](https://github.com/wiroai/Wiro-Zed) | Wiro AI MCP server extension for Zed |
| [Wiro-Action](https://github.com/wiroai/Wiro-Action) | GitHub Action for Wiro AI models and the LLM gateway, [on the GitHub Marketplace](https://github.com/marketplace/actions/wiro-ai-action) |
| [Wiro-Raycast](https://github.com/wiroai/Wiro-Raycast) | Wiro AI extension for Raycast: image and video generation, LLM chat and model search |
| [Wiro-WordPress](https://github.com/wiroai/Wiro-WordPress) | Wiro AI plugin for WordPress: featured images, image edits, alt text, narration and SEO suggestions |
| [Wiro-Obsidian](https://github.com/wiroai/Wiro-Obsidian) | Wiro AI plugin for Obsidian: images, video, speech, music, transcription and text tools |
| [Wiro-Blender](https://github.com/wiroai/Wiro-Blender) | Wiro AI add-on for Blender: text to 3D, image to 3D and textures |
| [Wiro-Figma](https://github.com/wiroai/Wiro-Figma) | Wiro AI plugin for Figma: images, vectors, image edits and text |
| [Wiro-Next-Starter](https://github.com/wiroai/Wiro-Next-Starter) | Next.js starter for Wiro AI: Playground, image, video and audio tools, and LLM chat, ready for Vercel and Railway |
| [Wiro-Docs](https://github.com/wiroai/Wiro-Docs) | Source of the Wiro AI API docs |

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [X](https://x.com/wiroai)

## License

MIT, see [LICENSE](./LICENSE).
