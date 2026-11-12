import { createHmac } from 'node:crypto';
import { generateImage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createWiro, wiro } from './index';
import {
  createMockWiro,
  finishedTask,
  output,
  PNG_BYTES,
  param,
  tool,
} from './test-helpers/mock-wiro';
import { runApiAuthHeaders, splitCredential } from './wiro-auth';

const CDN = 'https://cdn1.wiro.ai/files/0.png';

function setup() {
  return createMockWiro({
    tools: {
      'pruna/p-image': tool('pruna/p-image', [param('prompt', 'textarea', { required: true })]),
    },
    tasks: [finishedTask({ outputs: [output(CDN, 'image/png')] })],
    files: { [CDN]: { body: PNG_BYTES, contentType: 'image/png' } },
  });
}

describe('splitCredential', () => {
  it('reads an API key alone or a key and secret joined with a colon', () => {
    expect(splitCredential('key')).toEqual({ apiKey: 'key' });
    expect(splitCredential(' key:secret ')).toEqual({ apiKey: 'key', apiSecret: 'secret' });
    expect(splitCredential('key:')).toEqual({ apiKey: 'key' });
  });
});

describe('Run API authentication', () => {
  it('sends only x-api-key for an API Key Only project', async () => {
    expect(await runApiAuthHeaders('project-key')).toEqual({ 'x-api-key': 'project-key' });
  });

  it('signs each request of a Signature project with a fresh nonce', async () => {
    const first = await runApiAuthHeaders('project-key:project-secret');
    const second = await runApiAuthHeaders('project-key:project-secret');

    for (const headers of [first, second]) {
      expect(headers['x-api-key']).toBe('project-key');
      expect(headers['x-signature']).toBe(
        createHmac('sha256', 'project-key')
          .update(`project-secret${headers['x-nonce']}`)
          .digest('hex'),
      );
    }
    expect(Number(second['x-nonce'])).toBeGreaterThan(Number(first['x-nonce']));
  });

  it('signs every request of a call and never sends the secret', async () => {
    const mock = setup();
    const provider = createWiro({
      apiKey: 'project-key:project-secret',
      fetch: mock.fetch,
      poll: { intervalMs: 0 },
    });

    await generateImage({ model: provider.image('pruna/p-image'), prompt: 'A cat' });

    const apiRequests = mock.requests.filter((request) =>
      request.url.startsWith('https://api.wiro.ai/'),
    );
    expect(apiRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of apiRequests) {
      expect(request.headers['x-api-key']).toBe('project-key');
      expect(request.headers['x-signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(request)).not.toContain('project-secret');
    }
    const nonces = apiRequests.map((request) => request.headers['x-nonce']);
    expect(new Set(nonces).size).toBe(nonces.length);
    // The output download goes to the CDN without credentials.
    const download = mock.requests.find((request) => request.url === CDN);
    expect(download?.headers['x-api-key']).toBeUndefined();
  });

  it('reads WIRO_API_KEY when a request is made', async () => {
    const mock = setup();
    vi.stubGlobal('fetch', mock.fetch);
    vi.stubEnv('WIRO_API_KEY', 'env-key');

    await generateImage({ model: wiro.image('pruna/p-image'), prompt: 'A cat', maxRetries: 0 });

    expect(mock.runRequests()[0]?.headers['x-api-key']).toBe('env-key');
  });

  it('uses a custom Run API base URL and extra headers', async () => {
    const mock = createMockWiro({
      tools: { 'pruna/p-image': tool('pruna/p-image', [param('prompt', 'textarea')]) },
      tasks: [
        finishedTask({ outputs: [output('https://run.example.test/files/0.png', 'image/png')] }),
      ],
      files: {
        'https://run.example.test/files/0.png': { body: PNG_BYTES, contentType: 'image/png' },
      },
    });
    const provider = createWiro({
      apiKey: 'test-key',
      runBaseURL: 'https://run.example.test/v1/',
      headers: { 'X-Team': 'research' },
      fetch: mock.fetch,
      poll: { intervalMs: 0 },
    });

    await generateImage({ model: provider.image('pruna/p-image'), prompt: 'A cat' });

    expect(mock.runRequests()[0]?.url).toBe('https://run.example.test/v1/Run/pruna/p-image');
    expect(mock.runRequests()[0]?.headers['x-team']).toBe('research');
  });
});
