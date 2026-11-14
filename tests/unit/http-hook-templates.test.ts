/**
 * Unit tests for Hook Event Templates — validates template structure
 * and settings generation for Claude Code event reporting hooks.
 *
 * Note: These are command hooks (not HTTP hooks). Claude Code HTTP hooks
 * silently fail to fire as of v2.1.78, so we use command hooks that
 * POST to the server via hook-event-reporter.js.
 */

import { describe, it, expect } from 'vitest';
import {
  HTTP_HOOK_TEMPLATES,
  HOOK_EVENT_TEMPLATES,
  buildHttpHookSettings,
} from '../../src/data/http-hook-templates.js';

describe('Hook Event Templates', () => {
  describe('template structure', () => {
    it('covers all required observability events', () => {
      const events = HOOK_EVENT_TEMPLATES.map(t => t.event).sort();
      expect(events).toEqual([
        'PostToolUse',
        'PreCompact',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'TaskCompleted',
      ]);
    });

    it('all templates use command type', () => {
      for (const t of HOOK_EVENT_TEMPLATES) {
        expect(t.config.type).toBe('command');
      }
    });

    it('all templates reference hook-event-reporter.js', () => {
      for (const t of HOOK_EVENT_TEMPLATES) {
        expect(t.config.command).toContain('hook-event-reporter.js');
      }
    });

    it('all templates have reasonable timeouts', () => {
      for (const t of HOOK_EVENT_TEMPLATES) {
        expect(t.config.timeout).toBeLessThanOrEqual(5000);
      }
    });

    it('backwards-compat export matches new export', () => {
      expect(HTTP_HOOK_TEMPLATES).toBe(HOOK_EVENT_TEMPLATES);
    });
  });

  describe('buildHttpHookSettings()', () => {
    it('generates valid settings for each event type', () => {
      const settings = buildHttpHookSettings('http://localhost:3030');

      expect(Object.keys(settings).sort()).toEqual([
        'PostToolUse',
        'PreCompact',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'TaskCompleted',
      ]);
    });

    it('generates command hooks (not HTTP hooks)', () => {
      const settings = buildHttpHookSettings('http://localhost:4567');

      for (const entries of Object.values(settings)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.type).toBe('command');
            expect(hook.command).toContain('hook-event-reporter.js');
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
