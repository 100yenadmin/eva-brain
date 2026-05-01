import { loadConfig } from '../core/config.ts';
import { redactAuthResolution, resolveOpenAIAuth } from '../core/ai/auth.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../core/embedding.ts';

const SCHEMA_VERSION = 1;

export async function runProviders(subcommand: string | undefined, args: string[]): Promise<void> {
  switch (subcommand) {
    case 'list':
      return runList(args);
    case 'explain':
      return runExplain(args);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown providers subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`gbrain providers — provider auth status

USAGE
  gbrain providers list            List provider readiness without secrets
  gbrain providers explain [--json] Explain selected provider/auth source
`);
}

function currentAuth() {
  return resolveOpenAIAuth({ config: loadConfig() });
}

function runList(args: string[]): void {
  const asJson = args.includes('--json') || args.includes('-j');
  const auth = currentAuth();
  const payload = {
    schema_version: SCHEMA_VERSION,
    providers: [
      {
        id: 'openai',
        touchpoint: 'embedding',
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        ready: auth.isConfigured,
        auth: redactAuthResolution(auth),
      },
    ],
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('PROVIDER  TOUCHPOINT  MODEL                   DIMS  STATUS');
  console.log('--------  ----------  ----------------------  ----  ----------------');
  const row = payload.providers[0];
  const status = row.ready ? `ready (${row.auth.source})` : `missing (${row.auth.missingReason ?? 'credentials'})`;
  console.log(`${row.id.padEnd(8)}  ${row.touchpoint.padEnd(10)}  ${row.model.padEnd(22)}  ${String(row.dimensions).padEnd(4)}  ${status}`);
}

function runExplain(args: string[]): void {
  const asJson = args.includes('--json') || args.includes('-j');
  const auth = currentAuth();
  const payload = {
    schema_version: SCHEMA_VERSION,
    selected: {
      embedding: {
        provider: 'openai',
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        auth: redactAuthResolution(auth),
        ready: auth.isConfigured,
      },
    },
    notes: [
      'Secrets are never printed. Values are only used in-process for OpenAI SDK calls.',
      'Precedence: OPENAI_API_KEY env > gbrain config openai_api_key > OpenClaw auth profile bridge.',
    ],
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Embedding provider: openai (${EMBEDDING_MODEL}, ${EMBEDDING_DIMENSIONS} dims)`);
  console.log(`Auth source: ${auth.source}`);
  console.log(`Status: ${auth.isConfigured ? 'ready' : auth.missingReason ?? 'missing credentials'}`);
  if (auth.credentialKey) console.log(`Credential key: ${auth.credentialKey}`);
}
