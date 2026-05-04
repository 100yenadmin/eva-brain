import { describe, expect, test } from 'bun:test';

describe('serve-http security wiring', () => {
  test('HTTP MCP operation context is marked remote/untrusted', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const routeStart = source.indexOf("app.post('/mcp'");
    const routeEnd = source.indexOf('// Use StreamableHTTPServerTransport', routeStart);
    const mcpRoute = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(mcpRoute).toMatch(/const ctx: OperationContext = \{[\s\S]*remote: true,/);
  });

  test('admin cookies use Secure on HTTPS/public-proxy requests', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    expect(source).toContain("secure: req.secure || issuerUrl.protocol === 'https:'");
  });

  test('MCP request logging stores only redacted argument summaries', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const routeStart = source.indexOf("app.post('/mcp'");
    const routeEnd = source.indexOf('// Use StreamableHTTPServerTransport', routeStart);
    const mcpRoute = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(source).toContain('function summarizeMcpParams');
    expect(mcpRoute).toContain('const safeParams = summarizeMcpParams(params)');
    expect(mcpRoute).not.toContain('JSON.stringify(params)');
    expect(mcpRoute).not.toContain('params: params || {}');
  });

  test('MCP operation failures use the shared structured error envelope', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const routeStart = source.indexOf("app.post('/mcp'");
    const routeEnd = source.indexOf('// Use StreamableHTTPServerTransport', routeStart);
    const mcpRoute = source.slice(routeStart, routeEnd);

    expect(source).toContain("from '../core/errors.ts'");
    expect(mcpRoute).toContain('buildError({');
    expect(mcpRoute).toContain('serializeError(e)');
    expect(mcpRoute).toContain('JSON.stringify({ error: errorPayload })');
    expect(mcpRoute).not.toContain('e.toJSON()');
    expect(mcpRoute).not.toContain("error: 'internal_error'");
  });
});
