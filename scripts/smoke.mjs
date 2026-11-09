// Live check of the built package against the Wiro LLM gateway. It is not part
// of CI, and every call is billed to the project behind WIRO_API_KEY.
//
//   npm run build
//   WIRO_API_KEY=your-api-key node scripts/smoke.mjs
//
// It makes five calls on openai/gpt-5-4-nano: generateText, streamText, a tool
// loop (one call for the tool call, one for the answer) and Output.object.
// Each call has to report its cost in providerMetadata.wiro.cost. Retries are
// off, and a sixth request is refused before it is sent. The key is only read
// by the provider and is never printed.

import { generateText, isStepCount, Output, streamText, tool } from 'ai';
import { z } from 'zod';
import { createWiro } from '../dist/index.js';

const MODEL = 'openai/gpt-5-4-nano';
const MAX_REQUESTS = 5;

let requests = 0;
const countingFetch = async (url, init) => {
  if (requests >= MAX_REQUESTS) {
    throw new Error(`Refusing request ${requests + 1}: the smoke test allows ${MAX_REQUESTS}.`);
  }
  requests += 1;
  console.log(`  request ${requests}: POST ${url}`);
  return fetch(url, init);
};

const wiro = createWiro({ fetch: countingFetch });
const costs = [];
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function recordCost(label, providerMetadata) {
  const cost = providerMetadata?.wiro?.cost;
  check(`${label} has providerMetadata.wiro.cost`, typeof cost === 'number', `${cost} USD`);
  if (typeof cost === 'number') costs.push(cost);
}

const tokens = (usage) => `${usage.inputTokens} in, ${usage.outputTokens} out`;

async function run(label, test) {
  console.log(`\n${label}`);
  try {
    await test();
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${error?.name}: ${error?.message}`);
    if (error?.statusCode) console.log(`  status ${error.statusCode}`);
    if (error?.responseBody) console.log(`  body ${String(error.responseBody).slice(0, 500)}`);
  }
}

await run('1. generateText (providerOptions.wiro.reasoningEffort = "low")', async () => {
  const result = await generateText({
    model: wiro(MODEL),
    prompt: 'Explain what an API gateway does in one sentence.',
    providerOptions: { wiro: { reasoningEffort: 'low' } },
    maxRetries: 0,
  });
  console.log(`  text: ${result.text}`);
  console.log(`  usage: ${tokens(result.usage)}, finish: ${result.finishReason}`);
  check('text is not empty', result.text.trim().length > 0);
  recordCost('generateText', result.providerMetadata);
});

await run('2. streamText', async () => {
  const result = streamText({
    model: wiro(MODEL),
    prompt: 'Write a two-line poem about routing requests.',
    maxRetries: 0,
  });
  let text = '';
  for await (const part of result.textStream) text += part;
  console.log(`  text: ${text.replace(/\n/g, ' / ')}`);
  console.log(`  usage: ${tokens(await result.usage)}, finish: ${await result.finishReason}`);
  check('streamed text is not empty', text.trim().length > 0);
  recordCost('streamText', await result.providerMetadata);
});

await run('3. tool call, then the answer (two requests)', async () => {
  const result = await generateText({
    model: wiro(MODEL),
    tools: {
      getWeather: tool({
        description: 'Get the current weather for a city',
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temperatureC: 21, condition: 'sunny' }),
      }),
    },
    stopWhen: isStepCount(2),
    prompt: 'What is the weather in Istanbul right now?',
    maxRetries: 0,
  });
  const calls = result.steps.flatMap((step) => step.toolCalls);
  console.log(
    `  tool calls: ${calls.map((c) => `${c.toolName}(${JSON.stringify(c.input)})`).join(', ')}`,
  );
  console.log(`  answer: ${result.text}`);
  check(
    'the model called getWeather',
    calls.some((c) => c.toolName === 'getWeather'),
  );
  check('the model answered after the tool result', result.text.trim().length > 0);
  result.steps.forEach((step, index) => {
    recordCost(`step ${index + 1}`, step.providerMetadata);
  });
});

await run('4. Output.object', async () => {
  const result = await generateText({
    model: wiro(MODEL),
    output: Output.object({
      schema: z.object({ name: z.string(), country: z.string(), population: z.number() }),
    }),
    prompt: 'Give me the largest city in Turkey.',
    maxRetries: 0,
  });
  console.log(`  output: ${JSON.stringify(result.output)}`);
  check('output matches the schema', typeof result.output?.population === 'number');
  recordCost('Output.object', result.providerMetadata);
});

const total = costs.reduce((sum, cost) => sum + cost, 0);
console.log(`\n5. cost metadata`);
check(`every request reported a cost`, costs.length === requests, `${costs.length} of ${requests}`);
console.log(`  total: ${total.toFixed(8)} USD over ${requests} requests`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
