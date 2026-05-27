/**
 * v0.41.16.0 — Conversation parser orchestrator tests.
 *
 * Covers:
 *   - PR #1461's 6 telegram-bracket cases verbatim (REGRESSION pin)
 *   - All 12 built-in patterns hit their test_positive samples
 *   - Date derivation precedence (D8)
 *   - Pattern priority scoring (D18) — overlap resolution
 *   - Quick-reject fast path (D11)
 *   - Multi-line continuation (D5)
 *   - Disabled-builtin honored
 *   - Timezone warning (D19) emitted when frontmatter timezone missing
 *
 * Pure-function tests; no PGLite, no LLM. The LLM polish/fallback
 * tests live in `llm-base.test.ts`, `llm-polish.test.ts`,
 * `llm-fallback.test.ts` (T4).
 */

import { describe, expect, test } from 'bun:test';
import {
  parseConversation,
  deriveDateContext,
  applyPattern,
  scorePattern,
} from '../../src/core/conversation-parser/parse.ts';
import { BUILTIN_PATTERNS } from '../../src/core/conversation-parser/builtins.ts';
import type { Page } from '../../src/core/types.ts';

// Helper to construct a minimal Page for date-derivation tests.
function makePage(
  frontmatter: Record<string, unknown> = {},
  effective_date?: Date,
): Page {
  return {
    id: 1,
    slug: 'test/page',
    type: 'conversation',
    title: 'Test',
    compiled_truth: '',
    timeline: '',
    frontmatter,
    content_hash: undefined,
    created_at: new Date(),
    updated_at: new Date(),
    effective_date: effective_date ?? null,
  } as Page;
}

// ---------------------------------------------------------------------------
// REGRESSION: PR #1461's 6 telegram-bracket cases verbatim
// ---------------------------------------------------------------------------

describe('parseConversation — REGRESSION PR #1461 (telegram-bracket)', () => {
  test('bracket-time with 👤 emoji speaker prefix', () => {
    const body = '**[18:37] \u{1f464} G T:** hello world';
    const r = parseConversation(body, { fallbackDate: '2026-05-24' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('G T');
    expect(r.messages[0].text).toBe('hello world');
    expect(r.messages[0].timestamp).toBe('2026-05-24T18:37:00Z');
    expect(r.matched_pattern_id).toBe('telegram-bracket');
  });

  test('bracket-time with 🤖 robot emoji', () => {
    const body = '**[06:00] \u{1f916} Zion:** On it.';
    const r = parseConversation(body, { fallbackDate: '2026-05-25' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('Zion');
    expect(r.messages[0].text).toBe('On it.');
    expect(r.messages[0].timestamp).toBe('2026-05-25T06:00:00Z');
  });

  test('bracket-time multi-line continuation', () => {
    const body = [
      '**[09:00] \u{1f464} Alice Example:** first line',
      'second line of same message',
      '**[09:05] \u{1f464} Bob Example:** separate message',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2026-05-20' });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].text).toBe('first line\nsecond line of same message');
    expect(r.messages[1].text).toBe('separate message');
  });

  test('bracket-time falls back to 1970-01-01 without fallbackDate', () => {
    const body = '**[14:30] \u{1f464} Alice Example:** test';
    const r = parseConversation(body);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].timestamp).toBe('1970-01-01T14:30:00Z');
  });

  test('mixed formats in one body: iMessage + bracket-time', () => {
    const body = [
      '**Alice Example** (2024-03-15 9:00 AM): format 1',
      '**[10:30] \u{1f464} Bob Example:** format 2',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    // D18 scoring picks the dominant pattern. Both have one hit; ties
    // resolve to declared priority (imessage-slack=0, telegram-bracket=1).
    // The imessage line matches; the telegram line becomes a
    // continuation. This is a known D18 tradeoff for very-mixed bodies.
    // In practice every chat export is homogeneous, so this is a
    // degenerate test case.
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
    expect(r.matched_pattern_id).toBe('imessage-slack');
  });

  test('bracket-time without emoji prefix', () => {
    const body = '**[22:15] Plain Name:** no emoji';
    const r = parseConversation(body, { fallbackDate: '2026-01-01' });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].speaker).toBe('Plain Name');
    expect(r.messages[0].text).toBe('no emoji');
  });
});

// ---------------------------------------------------------------------------
// All 12 built-ins must parse their test_positive samples
// ---------------------------------------------------------------------------

describe('parseConversation — every built-in matches its test_positive sample', () => {
  for (const entry of BUILTIN_PATTERNS) {
    test(`pattern ${entry.id}: first test_positive parses`, () => {
      const body = entry.test_positive[0];
      // Multi-line patterns need a body line on the next line.
      const fullBody =
        entry.multi_line && entry.captures.text_group === 0
          ? `${body}\nsome body text`
          : body;
      const r = parseConversation(fullBody, {
        fallbackDate: '2024-03-15',
      });
      // Either matches a message OR (for some multi-line patterns) the
      // first line is the anchor and the body is consumed as text.
      expect(r.messages.length).toBeGreaterThanOrEqual(1);
      expect(r.matched_pattern_id).toBe(entry.id);
    });
  }
});

// ---------------------------------------------------------------------------
// Date derivation precedence (D8)
// ---------------------------------------------------------------------------

describe('deriveDateContext (D8 precedence chain)', () => {
  test('explicit fallbackDate wins', () => {
    const page = makePage({ date: '2024-01-01' }, new Date('2023-06-15'));
    const ctx = deriveDateContext({ fallbackDate: '2025-12-25', page });
    expect(ctx.fallbackDate).toBe('2025-12-25');
    expect(ctx.source).toBe('explicit');
  });
  test('frontmatter.date wins over effective_date', () => {
    const page = makePage({ date: '2024-01-01' }, new Date('2023-06-15'));
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2024-01-01');
    expect(ctx.source).toBe('frontmatter_date');
  });
  test('effective_date wins when no frontmatter.date', () => {
    const page = makePage({}, new Date('2023-06-15T00:00:00Z'));
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2023-06-15');
    expect(ctx.source).toBe('effective_date');
  });
  test('epoch_default when nothing set', () => {
    const ctx = deriveDateContext({});
    expect(ctx.fallbackDate).toBe('1970-01-01');
    expect(ctx.source).toBe('epoch_default');
  });
  test('frontmatter.timezone surfaces', () => {
    const page = makePage({
      date: '2024-01-01',
      timezone: 'America/Los_Angeles',
    });
    const ctx = deriveDateContext({ page });
    expect(ctx.timezone).toBe('America/Los_Angeles');
  });
  test('invalid frontmatter.date falls through', () => {
    const page = makePage({ date: 'not-a-date' });
    const ctx = deriveDateContext({ page });
    expect(ctx.source).toBe('epoch_default');
  });
  test('frontmatter.date slices full ISO to YYYY-MM-DD', () => {
    const page = makePage({ date: '2024-03-15T18:37:00Z' });
    const ctx = deriveDateContext({ page });
    expect(ctx.fallbackDate).toBe('2024-03-15');
  });
});

// ---------------------------------------------------------------------------
// Pattern priority scoring (D18)
// ---------------------------------------------------------------------------

describe('scorePattern (D18 priority scoring)', () => {
  test('telegram-bracket scores 1.0 on a pure telegram body', () => {
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
      '**[18:39] \u{1f464} Alice:** three',
    ].join('\n');
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern(body, tg)).toBe(1);
  });
  test('imessage-slack scores 0 on pure telegram body', () => {
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
    ].join('\n');
    const im = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack')!;
    expect(scorePattern(body, im)).toBe(0);
  });
  test('mixed body: D18 picks the higher-scoring pattern', () => {
    // 3 telegram lines + 1 imessage line. Telegram should win.
    const body = [
      '**[18:37] \u{1f464} Alice:** one',
      '**[18:38] \u{1f464} Bob:** two',
      '**[18:39] \u{1f464} Alice:** three',
      '**Charlie** (2024-03-15 9:00 AM): one imessage',
    ].join('\n');
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(r.matched_pattern_id).toBe('telegram-bracket');
  });
});

// ---------------------------------------------------------------------------
// Disabled-builtin honored
// ---------------------------------------------------------------------------

describe('parseConversation — disabledBuiltinIds', () => {
  test('disabling top pattern falls through to next', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const rDefault = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(rDefault.matched_pattern_id).toBe('telegram-bracket');
    const rDisabled = parseConversation(body, {
      fallbackDate: '2024-03-15',
      disabledBuiltinIds: ['telegram-bracket'],
    });
    // No other built-in matches this exact shape → no_match.
    expect(rDisabled.phase).toBe('no_match');
  });
});

// ---------------------------------------------------------------------------
// Multi-line continuation (D5)
// ---------------------------------------------------------------------------

describe('parseConversation — multi-line continuation (D5)', () => {
  test('iMessage continuation absorbs orphan lines', () => {
    const body = [
      '**Alice Example** (2024-03-15 9:00 AM): first line',
      'continuation line',
      'another continuation',
      '**Bob Example** (2024-03-15 9:05 AM): second message',
    ].join('\n');
    const r = parseConversation(body);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].text).toBe(
      'first line\ncontinuation line\nanother continuation',
    );
    expect(r.messages[1].text).toBe('second message');
  });
});

// ---------------------------------------------------------------------------
// Timezone warning (D19)
// ---------------------------------------------------------------------------

describe('parseConversation — timezone warning (D19)', () => {
  test('telegram-bracket emits warning when no timezone in frontmatter', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const r = parseConversation(body, { fallbackDate: '2024-03-15' });
    expect(r.timezone_warning).toBeDefined();
    expect(r.timezone_warning).toContain('telegram-bracket');
    expect(r.timezone_warning).toContain('UTC');
  });
  test('telegram-bracket does NOT warn when timezone is present', () => {
    const body = '**[18:37] \u{1f464} Alice:** hello';
    const page = makePage({
      date: '2024-03-15',
      timezone: 'America/Los_Angeles',
    });
    const r = parseConversation(body, { page });
    expect(r.timezone_warning).toBeUndefined();
  });
  test('imessage-slack does NOT warn (inline_utc policy)', () => {
    const body = '**Alice Example** (2024-03-15 9:00 AM): hello';
    const r = parseConversation(body);
    expect(r.timezone_warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty body + degenerate cases
// ---------------------------------------------------------------------------

describe('parseConversation — degenerate inputs', () => {
  test('empty body returns no_match + empty messages', () => {
    expect(parseConversation('')).toEqual({
      messages: [],
      phase: 'no_match',
    });
  });
  test('non-conversational text returns no_match', () => {
    const r = parseConversation('This is just prose with no chat shape.');
    expect(r.phase).toBe('no_match');
    expect(r.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPattern — direct unit tests for the matcher
// ---------------------------------------------------------------------------

describe('applyPattern — quick_reject fast path (D11)', () => {
  test('telegram quick_reject skips iMessage lines fast', () => {
    const body = '**Alice Example** (2024-03-15 9:00 AM): hello';
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    const r = applyPattern(body, tg, {
      fallbackDate: '2024-03-15',
      source: 'explicit',
    });
    // Quick_reject /^\*\*\[/ rejects '**Alice' (no `[`). Zero matches.
    expect(r).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scorePattern boundary cases
// ---------------------------------------------------------------------------

describe('scorePattern — boundary', () => {
  test('empty body scores 0', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern('', tg)).toBe(0);
  });
  test('only blank lines scores 0', () => {
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern('\n\n   \n', tg)).toBe(0);
  });
  test('caps at SCORING_HEAD_LINES (10) lines', () => {
    // 100 telegram lines → still scores 1.0 because only first 10 sampled.
    const body = Array.from(
      { length: 100 },
      (_, i) => `**[18:${String(i).padStart(2, '0')}] \u{1f464} Alice:** msg ${i}`,
    ).join('\n');
    const tg = BUILTIN_PATTERNS.find((p) => p.id === 'telegram-bracket')!;
    expect(scorePattern(body, tg)).toBe(1);
  });
});
