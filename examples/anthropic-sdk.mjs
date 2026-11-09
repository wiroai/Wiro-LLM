// The Anthropic SDK for JavaScript, pointed at the Wiro LLM gateway. The SDK
// adds /v1 to the base URL itself, so the base URL is the origin only. Any model
// ID works here, including claude/sonnet-5 and the other Claude models.
//
//   npm install @anthropic-ai/sdk@0.137
//   WIRO_API_KEY=your-api-key node anthropic-sdk.mjs

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.WIRO_API_KEY,
  authToken: null, // send only the Wiro key, even if ANTHROPIC_AUTH_TOKEN is set
  baseURL: 'https://llm.wiro.ai',
});

const message = await client.messages.create({
  model: 'openai/gpt-5-4-nano',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Explain what an API gateway does in one sentence.' }],
});

const text = message.content.find((block) => block.type === 'text');
console.log(text?.text);
console.log(`cost: ${message.usage.cost} USD`);
