/**
 * Migration Parity — Structural enforcement that changes to agent-installed
 * files always include corresponding post-update migrations.
 *
 * This test catches the class of bug where a feature works for new agents
 * (via init) but silently fails for existing agents (no migration).
 *
 * Triggered by: zombie-cleanup-kills-active-sessions bug (2026-03-20)
 * where HTTP hook URL changes weren't migrated to existing agents.
 */

import { describe, it, expect } from 'vitest';
import { HTTP_HOOK_TEMPLATES, buildHttpHookSettings } from '../../src/data/http-hook-templates.js';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATOR_PATH = path.join(import.meta.dirname, '../../src/core/PostUpdateMigrator.ts');
const migratorSource = fs.readFileSync(MIGRATOR_PATH, 'utf-8');

describe('Migration Parity', () => {
  describe('HTTP hook templates ↔ PostUpdateMigrator', () => {
    it('every env var in hook templates is handled by the migrator', () => {
      // Collect all unique allowedEnvVars across templates
      const allEnvVars = new Set<string>();
      for (const template of HTTP_HOOK_TEMPLATES) {
        for (const v of template.config.allowedEnvVars ?? []) {
          allEnvVars.add(v);
        }
      }

      // Env vars that are resolved at build time (by buildHttpHookSettings) don't need migrations —
      // they're baked into the URL. Only RUNTIME env vars (expanded by Claude Code) need migration.
      // INSTAR_SERVER_URL is resolved by buildHttpHookSettings at init time.
      // INSTAR_AUTH_TOKEN is used in the Authorization header, present since first init.
      const buildTimeVars = new Set(['INSTAR_SERVER_URL', 'INSTAR_AUTH_TOKEN']);

      // The migrator must reference each runtime env var that appears in templates.
      // If a new env var is added to templates but the migrator doesn't know
      // about it, existing agents won't have it in their allowedEnvVars.
      for (const envVar of allEnvVars) {
        if (buildTimeVars.has(envVar)) continue;
        expect(
          migratorSource.includes(envVar),
          `Env var "${envVar}" is used in HTTP hook templates but not referenced in PostUpdateMigrator. ` +
          `Add a migration to patch existing agents' .claude/settings.json.`,
        ).toBe(true);
      }
    });

    it('hook URL query params in templates are handled by the migrator', () => {
      // Extract query params from hook URL templates
      const sampleUrl = HTTP_HOOK_TEMPLATES[0]?.config.url ?? '';
      const queryMatch = sampleUrl.match(/\?(.+)$/);
      if (!queryMatch) return; // No query params — nothing to check

      const params = queryMatch[1].split('&').map(p => p.split('=')[0]);
      for (const param of params) {
        expect(
          migratorSource.includes(param),
          `URL query param "${param}" is in HTTP hook templates but not referenced in PostUpdateMigrator. ` +
          `Existing agents' hook URLs won't include this param without a migration.`,
        ).toBe(true);
      }
    });

    it('buildHttpHookSettings produces valid URLs with expected structure', () => {
      const settings = buildHttpHookSettings('http://localhost:4042');

      for (const [event, entries] of Object.entries(settings)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            const hookObj = hook as Record<string, unknown>;
            if (hookObj.type !== 'http') continue;

            const url = hookObj.url as string;

            // Server URL must be resolved (no template vars for the base)
            expect(url).not.toContain('${INSTAR_SERVER_URL}');
            expect(url.startsWith('http://localhost:4042/hooks/events')).toBe(true);

            // allowedEnvVars must include INSTAR_SESSION_ID for zombie cleanup
            const envVars = hookObj.allowedEnvVars as string[] | undefined;
            expect(
              envVars?.includes('INSTAR_SESSION_ID'),
              `Hook for "${event}" is missing INSTAR_SESSION_ID in allowedEnvVars. ` +
              `Zombie cleanup cannot correlate sessions without this.`,
            ).toBe(true);
          }
        }
      }
    });
  });

  describe('PostUpdateMigrator completeness', () => {
    it('migrateSettings is called from migrate()', () => {
      // Structural check: the migrate() method must call migrateSettings
      expect(migratorSource).toContain('this.migrateSettings(result)');
    });

    it('migrateHttpHookSessionId is called from migrateSettings', () => {
      // The session ID migration must be wired in
      expect(migratorSource).toContain('this.migrateHttpHookSessionId(');
    });

    it('migration handles missing INSTAR_SESSION_ID in allowedEnvVars', () => {
      // The migration method must check for and add INSTAR_SESSION_ID
      expect(migratorSource).toContain("'INSTAR_SESSION_ID'");
    });

    it('migration handles missing instar_sid in hook URLs', () => {
      // The migration method must check for and add the query param
      expect(migratorSource).toContain('instar_sid');
    });
  });
});
