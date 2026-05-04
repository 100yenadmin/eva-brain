import { completeSimple, getModel, type Message, type Model } from '@mariozechner/pi-ai';
import type { IncomingMessage, ServerResponse } from 'http';

const DEFAULT_MODEL = 'openai/gpt-5.4-mini';
const MAX_BODY_BYTES = 1_000_000;
const MAX_PROMPT_CHARS = 200_000;
const MAX_SYSTEM_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_TOKENS_LIMIT = 64_000;
const SUPPORTED_PROTOCOLS = new Set(['gbrain.codex-extraction.v1', 'gbrain.openclaw.complete.v1']);

interface ValidatedBody {
  protocol: string;
  model: string;
  prompt: string;
  system?: string;
  json: boolean;
  maxTokens?: number;
  timeoutMs: number;
  reasoning?: string;
}

class BridgeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

function splitModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash === -1) return { provider: 'openai-codex', model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new BridgeError('request_too_large', `request too large; max ${limit} bytes`, 413);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BridgeError('invalid_json', 'request body must be valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
  return true;
}

function sendError(res: ServerResponse, err: BridgeError): boolean {
  return sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, field: string, maxChars: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BridgeError('invalid_request', `${field} must be a string`);
  if (value.length > maxChars) throw new BridgeError('invalid_request', `${field} exceeds ${maxChars} characters`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BridgeError('invalid_request', `${field} must be a boolean`);
  return value;
}

function optionalPositiveInteger(body: Record<string, unknown>, field: string, max: number): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new BridgeError('invalid_request', `${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

function validateModelRef(input: Record<string, unknown>): string {
  const raw = optionalString(input, 'model', 200);
  if (raw === undefined) return DEFAULT_MODEL;

  const modelRef = raw.trim();
  if (!modelRef || /\s/.test(modelRef)) {
    throw new BridgeError('invalid_request', 'model must be a non-empty string without whitespace');
  }

  const segments = modelRef.split('/');
  if (segments.length > 2 || segments.some((segment) => !segment)) {
    throw new BridgeError('invalid_request', 'model must be a model id or "<provider>/<model>"');
  }

  return modelRef;
}

function validateBody(input: unknown): ValidatedBody {
  if (!isRecord(input)) throw new BridgeError('invalid_request', 'request body must be an object');
  const allowed = new Set(['protocol', 'model', 'prompt', 'system', 'json', 'maxTokens', 'timeoutMs', 'reasoning']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new BridgeError('invalid_request', `unsupported field: ${key}`);
  }

  const protocol = optionalString(input, 'protocol', 80) ?? 'gbrain.codex-extraction.v1';
  if (!SUPPORTED_PROTOCOLS.has(protocol)) throw new BridgeError('unsupported_protocol', `unsupported protocol: ${protocol}`);

  const prompt = optionalString(input, 'prompt', MAX_PROMPT_CHARS) ?? '';
  if (!prompt.trim()) throw new BridgeError('missing_prompt', 'prompt is required');

  return {
    protocol,
    model: validateModelRef(input),
    prompt,
    system: optionalString(input, 'system', MAX_SYSTEM_CHARS),
    json: optionalBoolean(input, 'json') ?? false,
    maxTokens: optionalPositiveInteger(input, 'maxTokens', MAX_TOKENS_LIMIT),
    timeoutMs: optionalPositiveInteger(input, 'timeoutMs', MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
    reasoning: optionalString(input, 'reasoning', 100),
  };
}

function textFromAssistant(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block: any) => block?.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function jsonFromText(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function attachResolvedAuth(model: Model<any>, auth: any): Model<any> {
  const headers = auth?.headers;
  const baseUrl = auth?.baseUrl ?? auth?.baseURL;
  const apiKey = auth?.apiKey;
  return {
    ...model,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
  } as Model<any>;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new BridgeError('completion_timeout', `completion timed out after ${timeoutMs}ms`, 504)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const plugin = {
  id: 'gbrain-completion',
  name: 'GBrain Completion Bridge',
  register(api: any) {
    api.registerHttpRoute({
      path: '/plugins/gbrain/complete',
      auth: 'gateway',
      match: 'exact',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        try {
          const body = validateBody(await readJson(req));

          const modelRef = body.model;
          const { provider, model: providerModel } = splitModelRef(modelRef);
          if (provider !== 'openai-codex' && provider !== 'openai') {
            throw new BridgeError('unsupported_provider', `unsupported provider: ${provider}`);
          }

          const model = getModel(provider, providerModel);
          const auth = await api.runtime.modelAuth.getRuntimeAuthForModel({ model, cfg: api.config });
          if (!auth?.apiKey) {
            throw new BridgeError(
              'model_auth_unsupported',
              'This bridge only supports API-key-backed model auth. OAuth/runtime transport-only auth is not supported by bundled pi-ai.',
            );
          }
          const authedModel = attachResolvedAuth(model, auth);
          const messages: Message[] = [
            ...(body.system ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: body.system }] }] : []),
            { role: 'user' as const, content: [{ type: 'text' as const, text: body.prompt }] },
          ];
          const assistant = await withTimeout(
            completeSimple(
              authedModel,
              { messages },
              {
                maxTokens: body.maxTokens,
                reasoning: body.reasoning,
              } as any,
            ),
            body.timeoutMs,
          );
          const text = textFromAssistant(assistant);
          return sendJson(res, 200, {
            ok: true,
            protocol: body.protocol,
            provider,
            model: providerModel,
            modelRef,
            text,
            ...(body.json ? { json: jsonFromText(text) } : {}),
            usage: (assistant as any).usage,
          });
        } catch (err) {
          if (err instanceof BridgeError) return sendError(res, err);
          api.logger?.error?.({ error: err instanceof Error ? err.message : String(err) }, 'gbrain completion bridge failed');
          return sendError(res, new BridgeError('completion_failed', 'completion bridge failed', 500));
        }
      },
    });
  },
};

export default plugin;
