import { completeSimple, getModel, type Message, type Model } from '@mariozechner/pi-ai';
import type { IncomingMessage, ServerResponse } from 'http';

const DEFAULT_MODEL = 'openai/gpt-5.4-mini';
const MAX_BODY_BYTES = 1_000_000;

interface CompleteBody {
  model?: string;
  prompt?: string;
  system?: string;
  json?: boolean;
  maxTokens?: number;
  reasoning?: string;
}

function splitModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash === -1) return { provider: 'openai-codex', model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<CompleteBody> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error(`request too large; max ${limit} bytes`);
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as CompleteBody;
}

function sendJson(res: ServerResponse, status: number, body: unknown): boolean {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
  return true;
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
          const body = await readJson(req);
          const prompt = typeof body.prompt === 'string' ? body.prompt : '';
          if (!prompt.trim()) return sendJson(res, 400, { ok: false, error: 'missing_prompt' });

          const modelRef = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
          const { provider, model: providerModel } = splitModelRef(modelRef);
          if (provider !== 'openai-codex' && provider !== 'openai') {
            return sendJson(res, 400, { ok: false, error: 'unsupported_provider', provider });
          }

          const model = getModel(provider, providerModel);
          const auth = await api.runtime.modelAuth.getRuntimeAuthForModel({ model, cfg: api.config });
          if (!auth?.apiKey) {
            return sendJson(res, 400, {
              ok: false,
              error: 'model_auth_unsupported',
              provider,
              model: providerModel,
              detail: 'This bridge only supports API-key-backed model auth. OAuth/runtime transport-only auth is not supported by bundled pi-ai.',
            });
          }
          const authedModel = attachResolvedAuth(model, auth);
          const messages: Message[] = [
            ...(body.system ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: body.system }] }] : []),
            { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
          ];
          const assistant = await completeSimple(
            authedModel,
            { messages },
            {
              maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
              reasoning: typeof body.reasoning === 'string' ? body.reasoning : undefined,
            } as any,
          );
          const text = textFromAssistant(assistant);
          return sendJson(res, 200, {
            ok: true,
            provider,
            model: providerModel,
            modelRef,
            text,
            ...(body.json ? { json: jsonFromText(text) } : {}),
            usage: (assistant as any).usage,
          });
        } catch (err) {
          api.logger?.error?.({ err }, 'gbrain completion bridge failed');
          return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  },
};

export default plugin;
