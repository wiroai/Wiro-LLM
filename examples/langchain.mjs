// LangChain's ChatOpenAI, pointed at the Wiro LLM gateway.
//
//   npm install @langchain/openai @langchain/core
//   WIRO_API_KEY=your-api-key node langchain.mjs

import { ChatOpenAI } from '@langchain/openai';

const llm = new ChatOpenAI({
  model: 'openai/gpt-5-4-nano',
  apiKey: process.env.WIRO_API_KEY,
  configuration: { baseURL: 'https://llm.wiro.ai/v1' },
});

const reply = await llm.invoke('Explain what an API gateway does in one sentence.');

console.log(reply.content);
console.log(reply.usage_metadata);
