// The OpenAI SDK for JavaScript, pointed at the Wiro LLM gateway.
//
//   npm install openai
//   WIRO_API_KEY=your-api-key node openai-sdk.mjs

import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.WIRO_API_KEY,
  baseURL: 'https://llm.wiro.ai/v1',
});

const completion = await client.chat.completions.create({
  model: 'openai/gpt-5-4-nano',
  max_completion_tokens: 512,
  messages: [{ role: 'user', content: 'Explain what an API gateway does in one sentence.' }],
});

console.log(completion.choices[0].message.content);
console.log(`cost: ${completion.usage?.cost} USD`);
