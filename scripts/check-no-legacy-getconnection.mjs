#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const ALLOWED = new Set([
  'src/core/db.ts',
  'src/core/postgres-engine.ts',
  'src/commands/init.ts',
  'src/commands/doctor.ts',
  'src/commands/files.ts',
  'src/commands/repair-jsonb.ts',
  'src/commands/serve-http.ts',
  'src/commands/integrity.ts',
  'src/core/operations.ts',
]);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function maskNonCode(source) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        out += '  ';
        i++;
        state = 'lineComment';
      } else if (ch === '/' && next === '*') {
        out += '  ';
        i++;
        state = 'blockComment';
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        out += ' ';
        state = 'string';
      } else {
        out += ch;
      }
      continue;
    }
    if (state === 'lineComment') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      } else {
        out += ' ';
      }
      continue;
    }
    if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i++;
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        out += ' ';
        if (next) {
          out += next === '\n' ? '\n' : ' ';
          i++;
        }
      } else if (ch === quote) {
        out += ' ';
        state = 'code';
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
    }
  }
  return out;
}

function lineNumber(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

const violations = [];
for (const abs of [...walk(join(ROOT, 'src/core')), ...walk(join(ROOT, 'src/commands'))]) {
  const rel = relative(ROOT, abs);
  if (ALLOWED.has(rel)) continue;
  const source = readFileSync(abs, 'utf-8');
  const code = maskNonCode(source);
  const re = /\bdb\s*\.\s*(getConnection|connect)\s*\(/g;
  let match;
  while ((match = re.exec(code)) !== null) {
    violations.push(`${rel}:${lineNumber(code, match.index)}: direct db.${match[1]}() call`);
  }
  const interpolationRe = /\$\{\s*db\s*\.\s*(getConnection|connect)\s*\(/g;
  while ((match = interpolationRe.exec(source)) !== null) {
    violations.push(`${rel}:${lineNumber(source, match.index)}: direct db.${match[1]}() call inside template interpolation`);
  }
}

if (violations.length > 0) {
  console.error('ERROR: new direct db.getConnection() / db.connect() call found in multi-brain code path:');
  console.error('');
  console.error(violations.join('\n'));
  console.error('');
  console.error('Use ctx.engine from the passed-in OperationContext instead.');
  console.error('See src/core/brain-registry.ts for the routing model.');
  console.error('If this call is legitimate, add its path to ALLOWED in scripts/check-no-legacy-getconnection.mjs with a PR 1 cleanup note.');
  process.exit(1);
}

console.log('check-no-legacy-getconnection: ok (no new singleton callers)');
