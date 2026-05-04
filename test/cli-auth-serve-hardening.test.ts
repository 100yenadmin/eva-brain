import { describe, expect, test } from 'bun:test';

describe('CLI auth/serve hardening invariants', () => {
  test('serve --http validates --public-url has a value', async () => {
    const source = await Bun.file(new URL('../src/commands/serve.ts', import.meta.url)).text();
    expect(source).toContain("console.error('--public-url requires a URL value.')");
    expect(source).toContain("raw.startsWith('--')");
  });

  test('auth register-client only allows HTTP redirect URIs for loopback hosts', async () => {
    const source = await Bun.file(new URL('../src/commands/auth.ts', import.meta.url)).text();
    expect(source).toContain("parsed.protocol !== 'https:'");
    expect(source).toContain("parsed.protocol === 'http:' && isLoopback");
    expect(source).toContain("parsed.hostname === 'localhost'");
    expect(source).toContain("parsed.hostname === '127.0.0.1'");
  });
});
