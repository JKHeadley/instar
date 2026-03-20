/**
 * Unit tests for HTTP Hook Templates — validates template structure
 * and settings generation for Claude Code HTTP hooks.
 */

import { describe, it, expect } from 'vitest';
import {
  HTTP_HOOK_TEMPLATES,
  buildHttpHookSettings,
} from '../../src/data/http-hook-templates.js';

describe('HTTP Hook Templates', () => {
  describe('template structure', () => {
    it('covers all required observability events', () => {
      const events = HTTP_HOOK_TEMPLATES.map(t => t.event).sort();
      expect(events).toEqual([
        'PostToolUse',
        'PreCompact',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'TaskCompleted',
        'WorktreeCreate',
        'WorktreeRemove',
      ]);
    });

    it('all templates use HTTP type', () => {
      for (const t of HTTP_HOOK_TEMPLATES) {
        expect(t.config.type).toBe('http');
      }
    });

    it('all templates have short timeouts (observability, not blocking)', () => {
      for (const t of HTTP_HOOK_TEMPLATES) {
        expect(t.config.timeout).toBeLessThanOrEqual(10);
      }
    });

    it('all templates include auth header', () => {
      for (const t of HTTP_HOOK_TEMPLATES) {
        expect(t.config.headers).toBeDefined();
        expect(t.config.headers!.Authorization).toContain('INSTAR_AUTH_TOKEN');
      }
    });

    it('all templates declare required env vars', () => {
      for (const t of HTTP_HOOK_TEMPLATES) {
        expect(t.config.allowedEnvVars).toContain('INSTAR_SERVER_URL');
        expect(t.config.allowedEnvVars).toContain('INSTAR_AUTH_TOKEN');
      }
    });
  });

  describe('buildHttpHookSettings()', () => {
    it('generates valid settings with resolved URL', () => {
      const settings = buildHttpHookSettings('http://localhost:3030');

      // Should have entries for each event type
      expect(Object.keys(settings).sort()).toEqual([
        'PostToolUse',
        'PreCompact',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'TaskCompleted',
        'WorktreeCreate',
        'WorktreeRemove',
      ]);
    });

    it('resolves INSTAR_SERVER_URL in hook URLs', () => {
      const settings = buildHttpHookSettings('http://localhost:4567');

      for (const entries of Object.values(settings)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.url).toBe('http://localhost:4567/hooks/events?instar_sid=${INSTAR_SESSION_ID}');
            expect(hook.url).not.toContain('${INSTAR_SERVER_URL}');
          }
        }
      }
    });

    it('preserves auth headers with env var interpolation', () => {
      const settings = buildHttpHookSettings('http://localhost:3030');

      for (const entries of Object.values(settings)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            const headers = hook.headers as Record<string, string>;
            // Auth token stays as env var reference (Claude Code resolves it)
            expect(headers.Authorization).toBe('Bearer ${INSTAR_AUTH_TOKEN}');
          }
        }
      }
    });

    it('each event has exactly one hook entry', () => {
      const settings = buildHttpHookSettings('http://localhost:3030');

      for (const [_event, entries] of Object.entries(settings)) {
        expect(entries).toHaveLength(1);
        expect(entries[0].hooks).toHaveLength(1);
      }
    });
  });
});
