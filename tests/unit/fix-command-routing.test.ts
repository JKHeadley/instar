/**
 * Tier-1 tests for shouldInterceptFixCommand — the routing decision that scopes
 * the emergency "fix command" gate to the Agent Attention topic.
 *
 * Regression context: the fix-command gate in wireTelegramRouting used to run
 * its verb test (`restart`/`fix `/`clean `) in EVERY topic. In a non-attention
 * topic handleFixCommand always returned false, so the gate bounced the message
 * back with "I didn't recognize that command" AND swallowed it (the gate
 * `return`s). That is exactly why a user typing "restart sessions" in a stuck
 * session's own topic never reached the session — the gate ate the message and
 * replied with a help list that even advertised "restart sessions" as valid.
 *
 * The fix: only intercept when the message is in the Agent Attention topic.
 * These tests pin both sides of that boundary with realistic inputs.
 */

import { describe, it, expect } from 'vitest';
import { shouldInterceptFixCommand } from '../../src/commands/server.js';

const ATTN = 999; // the Agent Attention topic id
const OTHER = 21624; // a normal session topic (the one from the incident screenshot)

describe('shouldInterceptFixCommand', () => {
  describe('in the Agent Attention topic — fix commands ARE intercepted', () => {
    const cases = [
      'restart sessions',
      'restart',
      'fix auth',
      'fix lifeline',
      'fix shadow',
      'fix output',
      'clean processes',
      'fix',
      'clean',
    ];
    for (const text of cases) {
      it(`intercepts "${text}"`, () => {
        expect(shouldInterceptFixCommand(text, ATTN, ATTN)).toBe(true);
      });
    }

    it('is case-insensitive', () => {
      expect(shouldInterceptFixCommand('RESTART SESSIONS', ATTN, ATTN)).toBe(true);
    });

    it('tolerates surrounding whitespace', () => {
      expect(shouldInterceptFixCommand('  restart sessions  ', ATTN, ATTN)).toBe(true);
    });

    it('does NOT intercept ordinary chat that lacks a fix verb', () => {
      expect(shouldInterceptFixCommand('hello there', ATTN, ATTN)).toBe(false);
      expect(shouldInterceptFixCommand('what is the status?', ATTN, ATTN)).toBe(false);
    });

    it('does NOT match verb-lookalike words (substring, not prefix-with-space)', () => {
      // "fixture" / "cleanup" / "restarting" guard against an over-eager match.
      // "fix " and "clean " require the trailing space; bare "fix"/"clean" must
      // be exact. ("restart" intentionally matches by prefix — it is the only
      // verb with no required argument, and this only fires in the control topic.)
      expect(shouldInterceptFixCommand('fixture data looks wrong', ATTN, ATTN)).toBe(false);
      expect(shouldInterceptFixCommand('cleanup the table', ATTN, ATTN)).toBe(false);
    });
  });

  describe('outside the Agent Attention topic — fix verbs FALL THROUGH to the session', () => {
    // This is the core of the bug fix: these must NOT be intercepted, so the
    // routing below in wireTelegramRouting delivers them to the live session.
    it('does NOT intercept "restart sessions" in a normal topic (the incident)', () => {
      expect(shouldInterceptFixCommand('restart sessions', OTHER, ATTN)).toBe(false);
    });

    it('does NOT intercept ordinary conversation that happens to start with a fix verb', () => {
      expect(shouldInterceptFixCommand('restart the build', OTHER, ATTN)).toBe(false);
      expect(shouldInterceptFixCommand('fix the login page', OTHER, ATTN)).toBe(false);
      expect(shouldInterceptFixCommand('clean up this function', OTHER, ATTN)).toBe(false);
      expect(shouldInterceptFixCommand('fix', OTHER, ATTN)).toBe(false);
    });
  });

  describe('when the attention topic id is unknown — never intercept', () => {
    it('returns false for null attention topic even with a fix verb', () => {
      expect(shouldInterceptFixCommand('restart sessions', ATTN, null)).toBe(false);
    });
    it('returns false for undefined attention topic even with a fix verb', () => {
      expect(shouldInterceptFixCommand('restart sessions', ATTN, undefined)).toBe(false);
    });
  });
});
