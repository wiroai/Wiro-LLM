// The Wiro provider for the AI SDK.
//
//   npm install @wiro-ai/ai-sdk-provider ai
//   WIRO_API_KEY=your-api-key node ai-sdk.mjs

import { wiro } from '@wiro-ai/ai-sdk-provider';
import { generateText } from 'ai';

const { text, usage, providerMetadata } = await generateText({
  model: wiro('openai/gpt-5-4-nano'),
  prompt: 'Explain what an API gateway does in one sentence.',
});

console.log(text);
console.log(`${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`);
console.log(`cost: ${providerMetadata?.wiro?.cost} USD`);
