import { beforeEach, describe, expect, mock, test } from 'bun:test';

let completeSimpleImpl = async () => ({
  content: [{ type: 'text', text: '{"answer":"ok"}' }],
  usage: { inputTokens: 3, outputTokens: 5 },
});

const completeSimpleMock = mock(async (...args: unknown[]) => completeSimpleImpl(...args));
const getModelMock = mock((provider: string, model: string) => ({ provider, model }));

mock.module('@mariozechner/pi-ai', () => ({
  completeSimple: completeSimpleMock,
  getModel: getModelMock,
}));

const { default: plugin } = await import('../src/index.ts');

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

interface CallBridgeOptions {
  auth?: unknown;
}

async function callBridge(body: unknown, options: CallBridgeOptions = {}) {
  let handler: any;
  const api = {
    config: {},
    runtime: {
      modelAuth: {
        getRuntimeAuthForModel: async () => options.auth,
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
  beforeEach(() => {
    completeSimpleImpl = async () => ({
      content: [{ type: 'text', text: '{"answer":"ok"}' }],
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    completeSimpleMock.mockClear();
    getModelMock.mockClear();
  });

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

  test('rejects blank and malformed model values before auth lookup', async () => {
    for (const model of [' ', 'openai/', '/gpt-5.4-mini', 'openai/gpt 5']) {
      const res = await callBridge({ model, prompt: 'hello' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'invalid_request' });
    }
    expect(getModelMock).not.toHaveBeenCalled();
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

  test('returns shaped completion output when API-key auth is available', async () => {
    const res = await callBridge(
      {
        protocol: 'gbrain.codex-extraction.v1',
        prompt: 'hello',
        json: true,
        maxTokens: 32,
        reasoning: 'low',
      },
      { auth: { apiKey: 'test-key' } },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      protocol: 'gbrain.codex-extraction.v1',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      modelRef: 'openai/gpt-5.4-mini',
      text: '{"answer":"ok"}',
      json: { answer: 'ok' },
      usage: { inputTokens: 3, outputTokens: 5 },
    });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
  });

  test('returns a controlled timeout error when completion hangs', async () => {
    completeSimpleImpl = async () =>
      await new Promise((resolve) => {
        setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 50);
      });

    const res = await callBridge({ prompt: 'hello', timeoutMs: 1 }, { auth: { apiKey: 'test-key' } });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ ok: false, error: 'completion_timeout' });
  });
});
