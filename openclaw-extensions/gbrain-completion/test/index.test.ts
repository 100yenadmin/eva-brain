import { describe, expect, test } from 'bun:test';
import plugin from '../src/index.ts';

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }

  end(value: string) {
    this.body = value;
  }
}

function makeReq(body: unknown, method = 'POST') {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

async function callBridge(body: unknown) {
  let handler: any;
  const api = {
    config: {},
    runtime: {
      modelAuth: {
        getRuntimeAuthForModel: async () => undefined,
      },
    },
    registerHttpRoute(route: any) {
      handler = route.handler;
    },
    logger: { error: () => {} },
  };
  plugin.register(api);
  const res = new MockResponse();
  await handler(makeReq(body), res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('gbrain-completion bridge validation', () => {
  test('rejects unsupported protocol with a controlled error', async () => {
    const res = await callBridge({ protocol: 'bad.v1', prompt: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'unsupported_protocol' });
  });

  test('rejects unknown request fields', async () => {
    const res = await callBridge({ prompt: 'hello', apiKey: 'secret' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  test('fails closed when runtime auth is not API-key backed', async () => {
    const res = await callBridge({
      protocol: 'gbrain.codex-extraction.v1',
      model: 'openai-codex/gpt-5.4-mini',
      prompt: 'hello',
      json: true,
      timeoutMs: 1000,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'model_auth_unsupported' });
  });
});
