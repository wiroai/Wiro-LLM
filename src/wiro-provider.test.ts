import { LoadAPIKeyError, NoSuchModelError } from '@ai-sdk/provider';
import { generateText, Output, streamText, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWiro, wiro } from './index';

type RecordedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function eventStreamResponse(chunks: unknown[]): Response {
  const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function mockFetch(respond: () => Response) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return respond();
  });
  return { fetch, requests };
}

const MODEL = 'openai/gpt-5-4-nano';

function completion(
  message: Record<string, unknown>,
  usage: Record<string, unknown> = {},
  finishReason = 'stop',
) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1_786_000_000,
    model: MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, ...usage },
  };
}

function chunk(fields: Record<string, unknown>) {
  return {
    id: 'chatcmpl-2',
    object: 'chat.completion.chunk',
    created: 1_786_000_000,
    model: MODEL,
    ...fields,
  };
}

const streamChunks = [
  chunk({
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
  }),
  chunk({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  chunk({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, cost: 0.000018 },
  }),
];

describe('generateText', () => {
  it('posts to the chat completions route with the key and the request body', async () => {
    const { fetch, requests } = mockFetch(() =>
      jsonResponse(completion({ content: 'Hello from Wiro.' }, { cost: 0.000021 })),
    );
    const provider = createWiro({ apiKey: 'test-key', fetch });

    const result = await generateText({
      model: provider(MODEL),
      prompt: 'Say hello',
      temperature: 0.2,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://llm.wiro.ai/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer test-key');
    expect(requests[0].headers['content-type']).toBe('application/json');
    expect(requests[0].body).toEqual({
      model: MODEL,
      temperature: 0.2,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    expect(result.text).toBe('Hello from Wiro.');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('exposes usage.cost as providerMetadata.wiro.cost', async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(completion({ content: 'Hi' }, { cost: 0.000021 })),
    );

    const result = await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Say hello',
    });

    expect(result.providerMetadata?.wiro?.cost).toBe(0.000021);
  });

  it('leaves the cost out when the response has none', async () => {
    const { fetch } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));

    const result = await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Say hello',
    });

    expect(result.providerMetadata?.wiro).toEqual({});
  });

  it('sends providerOptions.wiro.reasoningEffort as reasoning_effort', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Yes' })));

    await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Is 97 a prime number?',
      providerOptions: { wiro: { reasoningEffort: 'low' } },
    });

    expect(requests[0].body.reasoning_effort).toBe('low');
  });

  it('sends the AI SDK reasoning option as reasoning_effort', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Yes' })));

    await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Is 97 a prime number?',
      reasoning: 'high',
    });

    expect(requests[0].body.reasoning_effort).toBe('high');
  });

  it('adds other providerOptions.wiro keys to the request body unchanged', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));

    await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Say hello',
      providerOptions: { wiro: { parallel_tool_calls: false } },
    });

    expect(requests[0].body.parallel_tool_calls).toBe(false);
  });

  it('sends a JSON schema for Output.object and parses the answer', async () => {
    const { fetch, requests } = mockFetch(() =>
      jsonResponse(completion({ content: '{"name":"Istanbul","country":"Turkey"}' })),
    );

    const { output } = await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      output: Output.object({ schema: z.object({ name: z.string(), country: z.string() }) }),
      prompt: 'Give me the largest city in Turkey.',
    });

    expect(output).toEqual({ name: 'Istanbul', country: 'Turkey' });
    expect(requests[0].body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, country: { type: 'string' } },
        },
      },
    });
  });

  it('sends tools and returns the tool call', async () => {
    const { fetch, requests } = mockFetch(() =>
      jsonResponse(
        completion(
          {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'getWeather', arguments: '{"city":"Istanbul"}' },
              },
            ],
          },
          {},
          'tool_calls',
        ),
      ),
    );

    const result = await generateText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      tools: {
        getWeather: tool({
          description: 'Get the current weather for a city',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => ({ city, temperatureC: 21 }),
        }),
      },
      prompt: 'What is the weather in Istanbul?',
    });

    expect(requests[0].body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'getWeather',
          description: 'Get the current weather for a city',
          parameters: expect.objectContaining({
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          }),
        },
      },
    ]);
    expect(result.toolCalls).toMatchObject([
      { toolCallId: 'call_1', toolName: 'getWeather', input: { city: 'Istanbul' } },
    ]);
    expect(result.toolResults).toMatchObject([
      { toolCallId: 'call_1', output: { city: 'Istanbul', temperatureC: 21 } },
    ]);
  });
});

describe('streamText', () => {
  it('posts a streaming request with usage turned on', async () => {
    const { fetch, requests } = mockFetch(() => eventStreamResponse(streamChunks));

    const result = streamText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Say hello',
    });

    let text = '';
    for await (const part of result.textStream) text += part;

    expect(text).toBe('Hello there');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://llm.wiro.ai/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer test-key');
    expect(requests[0].body).toEqual({
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect((await result.usage).outputTokens).toBe(2);
  });

  it('exposes the cost from the last chunk as providerMetadata.wiro.cost', async () => {
    const { fetch } = mockFetch(() => eventStreamResponse(streamChunks));

    const result = streamText({
      model: createWiro({ apiKey: 'test-key', fetch })(MODEL),
      prompt: 'Say hello',
    });

    await result.consumeStream();

    expect((await result.providerMetadata)?.wiro?.cost).toBe(0.000018);
  });
});

describe('API key', () => {
  it('reads WIRO_API_KEY when the request is made, not when the provider is created', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));
    const provider = createWiro({ fetch });

    vi.stubEnv('WIRO_API_KEY', 'env-key');
    await generateText({ model: provider(MODEL), prompt: 'Say hello' });

    expect(requests[0].headers.authorization).toBe('Bearer env-key');
  });

  it('lets the apiKey option win over WIRO_API_KEY', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));
    vi.stubEnv('WIRO_API_KEY', 'env-key');

    await generateText({
      model: createWiro({ apiKey: 'option-key', fetch })(MODEL),
      prompt: 'Say hello',
    });

    expect(requests[0].headers.authorization).toBe('Bearer option-key');
  });

  it('sends a Signature credential (KEY:SECRET) unchanged', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));

    await generateText({
      model: createWiro({ apiKey: 'project-key:project-secret', fetch })(MODEL),
      prompt: 'Say hello',
    });

    expect(requests[0].headers.authorization).toBe('Bearer project-key:project-secret');
  });

  it('uses WIRO_API_KEY with the default wiro instance', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('WIRO_API_KEY', 'env-key');

    const result = await generateText({ model: wiro(MODEL), prompt: 'Say hello' });

    expect(result.text).toBe('Hi');
    expect(requests[0].url).toBe('https://llm.wiro.ai/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer env-key');
  });

  it('fails before sending anything when no key is set', async () => {
    const { fetch } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));
    vi.stubEnv('WIRO_API_KEY', undefined);

    const call = generateText({ model: createWiro({ fetch })(MODEL), prompt: 'Say hello' });

    await expect(call).rejects.toThrow(LoadAPIKeyError);
    await expect(call).rejects.toThrow(/WIRO_API_KEY/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('provider settings', () => {
  it('uses a custom base URL and extra headers', async () => {
    const { fetch, requests } = mockFetch(() => jsonResponse(completion({ content: 'Hi' })));
    const provider = createWiro({
      apiKey: 'test-key',
      baseURL: 'https://gateway.example.test/v1/',
      headers: { 'X-Team': 'research' },
      fetch,
    });

    await generateText({ model: provider(MODEL), prompt: 'Say hello' });

    expect(requests[0].url).toBe('https://gateway.example.test/v1/chat/completions');
    expect(requests[0].headers['x-team']).toBe('research');
    expect(requests[0].headers.authorization).toBe('Bearer test-key');
  });

  it('returns the same chat model from wiro(), chatModel() and languageModel()', () => {
    const provider = createWiro({ apiKey: 'test-key' });

    for (const model of [
      provider(MODEL),
      provider.chatModel(MODEL),
      provider.languageModel(MODEL),
    ]) {
      expect(model.provider).toBe('wiro.chat');
      expect(model.modelId).toBe(MODEL);
      expect(model.specificationVersion).toBe('v4');
    }
  });

  it('throws NoSuchModelError for embedding and image models', () => {
    expect(() => wiro.embeddingModel('any')).toThrow(NoSuchModelError);
    expect(() => wiro.imageModel('any')).toThrow(NoSuchModelError);
  });

  it('cannot be called with new', () => {
    expect(() => new (wiro as unknown as new (id: string) => unknown)(MODEL)).toThrow(
      /new keyword/,
    );
  });
});
