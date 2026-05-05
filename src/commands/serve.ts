import type { BrainEngine } from '../core/engine.ts';
import { startMcpServer } from '../mcp/server.ts';

function parsePositiveIntOption(
  args: string[],
  flag: string,
  fallback: number,
  opts: { max?: number } = {},
): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = args[idx + 1];
  if (!raw || raw.startsWith('--')) {
    console.error(`${flag} requires a positive integer value.`);
    process.exit(2);
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    console.error(`Invalid ${flag} value: "${raw}". Expected a positive integer.`);
    process.exit(2);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (opts.max !== undefined && value > opts.max)) {
    const suffix = opts.max !== undefined ? ` between 1 and ${opts.max}` : ' that fits in a safe integer';
    console.error(`Invalid ${flag} value: "${raw}". Expected a positive integer${suffix}.`);
    process.exit(2);
  }
  return value;
}

export async function runServe(engine: BrainEngine, args: string[] = []) {
  // v0.26+: --http dispatches to the full OAuth 2.1 server (serve-http.ts)
  // with admin dashboard, scope enforcement, SSE feed, and the requireBearerAuth
  // middleware. Master's simpler startHttpTransport from v0.22.7 is superseded
  // — the OAuth provider in serve-http.ts handles bearer auth via
  // verifyAccessToken with legacy access_tokens fallback (so v0.22.7 callers
  // that used `gbrain auth create` keep working unchanged).
  const isHttp = args.includes('--http');

  if (isHttp) {
    const port = parsePositiveIntOption(args, '--port', 3131, { max: 65535 });
    const tokenTtl = parsePositiveIntOption(args, '--token-ttl', 3600);

    const enableDcr = args.includes('--enable-dcr');

    const publicUrlIdx = args.indexOf('--public-url');
    const publicUrl =
      publicUrlIdx >= 0
        ? (() => {
            const raw = args[publicUrlIdx + 1];
            if (!raw || raw.startsWith('--')) {
              console.error('--public-url requires a URL value.');
              process.exit(2);
            }
            return raw;
          })()
        : undefined;

    // F8 escape hatch: --log-full-params writes raw payloads to mcp_request_log
    // and the admin SSE feed instead of redacted summaries. Off by default
    // (privacy-first); operators running gbrain on their own laptop can flip
    // it on for debug visibility. Loud startup warning fires in serve-http.ts
    // when set so the posture change is visible in stderr.
    const logFullParams = args.includes('--log-full-params');

    const { runServeHttp } = await import('./serve-http.ts');
    await runServeHttp(engine, { port, tokenTtl, enableDcr, publicUrl, logFullParams });
  } else {
    console.error('Starting GBrain MCP server (stdio)...');
    await startMcpServer(engine);
  }
}
