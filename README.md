<div align="center">

<img src="https://raw.githubusercontent.com/wiroai/Wiro-Plugin/main/.github/assets/wiro-logo.png" alt="Wiro AI" width="240">

# Wiro AI provider for the AI SDK

Use the models on the Wiro LLM gateway from the Vercel AI SDK, with streaming, tool calls and structured output, and see what each call cost.

[![npm](https://img.shields.io/npm/v/@wiro-ai/ai-sdk-provider?style=for-the-badge&color=111111)](https://www.npmjs.com/package/@wiro-ai/ai-sdk-provider) [![AI SDK 7](https://img.shields.io/badge/AI%20SDK-7-111111?style=for-the-badge&color=111111)](https://ai-sdk.dev) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-111111?style=for-the-badge&color=111111)](#install) [![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=for-the-badge&color=111111)](./LICENSE)

[Website](https://wiro.ai) · [LLM gateway](https://wiro.ai/llm) · [Models](https://wiro.ai/models?categories=llm-tool-call) · [Docs](https://wiro.ai/docs/completions-api#llm-setup-ai-sdk) · [Dashboard](https://wiro.ai/panel)

</div>

The [Wiro LLM gateway](https://wiro.ai/llm) serves language models from OpenAI, Anthropic, Google, xAI, DeepSeek, Qwen and others through one OpenAI-compatible endpoint, `https://llm.wiro.ai/v1`, with one Wiro project key. Every response includes what the call cost, and calls are paid from your Wiro wallet.

`@wiro-ai/ai-sdk-provider` brings the gateway into the [AI SDK](https://ai-sdk.dev). It is built on `@ai-sdk/openai-compatible` and sets it up for Wiro: the key comes from `WIRO_API_KEY`, streamed calls report token usage, `Output.object` sends a JSON schema, and the cost of each call lands in `providerMetadata.wiro.cost`.

## Install

```bash
npm install @wiro-ai/ai-sdk-provider ai zod
```

The package needs Node.js 22 or later, the same as AI SDK 7. `zod` is used for tool inputs and structured output.

Create a project at [wiro.ai/panel/project/new](https://wiro.ai/panel/project/new) and put its credential in `WIRO_API_KEY`: the API key for an API Key Only project, or `API_KEY:API_SECRET` (both values joined with a colon) for a Signature project. Call the gateway from server code so the key never reaches a browser.

```bash
export WIRO_API_KEY=your-api-key
```

## Quick start

```js
import { wiro } from '@wiro-ai/ai-sdk-provider';
import { generateText } from 'ai';

const { text } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  prompt: 'Explain what an API gateway does in one sentence.',
});

console.log(text);
```

`wiro(modelId)`, `wiro.chatModel(modelId)` and `wiro.languageModel(modelId)` return the same chat model. On reasoning models, `maxOutputTokens` covers the reasoning as well as the answer, so leave room if you set it (512 or more).

### Settings

`createWiro()` makes a provider with your own settings. The default `wiro` instance is `createWiro()` with no options.

```js
import { createWiro } from '@wiro-ai/ai-sdk-provider';

const wiro = createWiro({
  apiKey: process.env.MY_WIRO_KEY,
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `apiKey` | `WIRO_API_KEY` | Your project credential, sent as `Authorization: Bearer <apiKey>`. Use `API_KEY:API_SECRET` for a Signature project. |
| `baseURL` | `https://llm.wiro.ai/v1` | The gateway URL. |
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

## Models

Model IDs are lowercase `owner/model`, such as `openai/gpt-6-sol`, `claude/sonnet-5`, `google/gemini-3-pro`, `xai/grok-4-5`, `deepseek/v4-pro` or `qwen/qwen3-32b`. The `WiroChatModelId` type lists the models the gateway served when this version was published, so your editor can complete them, and any other ID works as well. Browse them in the [model catalog](https://wiro.ai/models?categories=llm-tool-call) or with `GET https://llm.wiro.ai/v1/models`, which also shows each model's tools, modalities and limits.

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

## Other SDKs and frameworks

The gateway works with the SDKs you may already use. [`examples/`](./examples) has a short, runnable file for each:

| File | Shows |
| --- | --- |
| [`ai-sdk.mjs`](./examples/ai-sdk.mjs) | This package with `generateText` |
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
- [AI SDK documentation](https://ai-sdk.dev/docs/introduction): `generateText`, `streamText`, tools and structured output

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The tests use a mocked `fetch` and make no network calls. `scripts/smoke.mjs` checks the built package against the live gateway with five small calls on `openai/gpt-5-4-nano`, billed to the project behind `WIRO_API_KEY`. It is not part of CI:

```bash
npm run build
WIRO_API_KEY=your-api-key npm run smoke
```

## Support, terms and privacy

Email [support@wiro.ai](mailto:support@wiro.ai) or open an issue in this repository. Use of Wiro AI through this package is covered by the Wiro AI [Terms of Service](https://wiro.ai/agreement/terms-of-service) and [Privacy Policy](https://wiro.ai/agreement/privacy-policy).

## More from Wiro AI

| Repository | What it is |
| --- | --- |
| [Wiro-Plugin](https://github.com/wiroai/Wiro-Plugin) | Wiro AI plugin for Cursor, Claude Code, Gemini CLI, Devin, Antigravity and Kiro |
| [Wiro-MCP](https://github.com/wiroai/Wiro-MCP) | Official MCP server for Wiro AI, [`@wiro-ai/wiro-mcp` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-mcp) |
| [Swift-QuickStart](https://github.com/wiroai/Swift-QuickStart) | WiroKit, the Wiro AI SDK for iOS |
| [Kotlin-QuickStart](https://github.com/wiroai/Kotlin-QuickStart) | WiroKit, the Wiro AI SDK for Android |
| [Dart-QuickStart](https://github.com/wiroai/Dart-QuickStart) | Wiro AI SDK for Dart and Flutter, [`wiro` on pub.dev](https://pub.dev/packages/wiro) |
| [ReactNative-QuickStart](https://github.com/wiroai/ReactNative-QuickStart) | Wiro AI SDK for React Native and Expo, [`@wiro-ai/wiro-react-native` on npm](https://www.npmjs.com/package/@wiro-ai/wiro-react-native) |
| [Swift-Realtime](https://github.com/wiroai/Swift-Realtime) | Realtime voice AI example for iOS |
| [Kotlin-Realtime](https://github.com/wiroai/Kotlin-Realtime) | Realtime voice AI example for Android |
| [Dart-Realtime](https://github.com/wiroai/Dart-Realtime) | Realtime voice AI example for Flutter |
| [ReactNative-Realtime](https://github.com/wiroai/ReactNative-Realtime) | Realtime voice AI example for React Native |
| [n8n-nodes-wiroai](https://github.com/wiroai/n8n-nodes-wiroai) | Wiro AI nodes for n8n, [`@wiro-ai/n8n-nodes-wiroai` on npm](https://www.npmjs.com/package/@wiro-ai/n8n-nodes-wiroai) |
| [Wiro-Docs](https://github.com/wiroai/Wiro-Docs) | Source of the Wiro AI API docs |

[Website](https://wiro.ai) · [Models](https://wiro.ai/models) · [Docs](https://wiro.ai/docs) · [X](https://x.com/wiroai)

## License

MIT, see [LICENSE](./LICENSE).
