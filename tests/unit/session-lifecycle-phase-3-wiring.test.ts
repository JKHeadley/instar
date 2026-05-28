/**
 * Phase-3 routing contracts — UNIFIED-SESSION-LIFECYCLE per-killer guarantees.
 *
 * #7 quota-shed (bounded soft-check + ReapAuthority routing) and the
 * label-follows-topic-rename bonus.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const migratorSource = fs.readFileSync(
  path.join(process.cwd(), 'src/monitoring/SessionMigrator.ts'),
  'utf-8',
);
const quotaManagerSource = fs.readFileSync(
  path.join(process.cwd(), 'src/monitoring/QuotaManager.ts'),
  'utf-8',
);

describe('Phase 3 — per-killer routing contracts', () => {
  describe('#7 quota-shed → bounded soft-check + ReapAuthority', () => {
    it('SessionMigrator threshold gains a bounded soft-check ceiling', () => {
      expect(migratorSource).toContain('softCheckEnabled');
      expect(migratorSource).toContain('softCheckMaxUsagePercent');
      expect(migratorSource).toContain('softCheckExtraGraceMs');
    });

    it('the soft check fires ONLY when usage is below the ceiling (SE-9 fail-closed)', () => {
      // The "softCheckActive" gate combines both flag + ceiling.
      expect(migratorSource).toMatch(/softCheckActive\s*=\s*softEnabled\s*&&\s*currentUsagePct\s*<=\s*softCeilingPct/);
      // Fail-closed: unknown usage ⇒ assume 100% so the soft check is disabled.
      expect(quotaManagerSource).toMatch(/usagePercent\s*\?\?\s*100/);
    });

    it('a working session gets ONE extra Ctrl+C grace round before force-kill', () => {
      // Inside the kill loop, when the work-check fires we send another C-c and
      // wait the extra grace before force-killing.
      const phase3Block = migratorSource.match(/Phase 3: Kill any sessions still alive[\s\S]*?return halted;/);
      expect(phase3Block).toBeTruthy();
      const body = phase3Block![0];
      expect(body).toContain("sendKey(session.tmuxSession, 'C-c')");
      expect(body).toContain('await this.sleep(softExtraGraceMs)');
      expect(body).toContain('one extra');
    });

    it('routes the force-kill through the single ReapAuthority when wired', () => {
      expect(migratorSource).toMatch(/this\.deps\.terminateSession\(\s*session\.id\s*,\s*'quota-shed'/);
      expect(migratorSource).toContain("disposition: 'terminal'");
      expect(migratorSource).toContain("finalStatus: 'killed'");
    });

    it('emits a structural force-kill decision event for future tier1 supervision', () => {
      // The kill happens — this is observability, not a gate. A tier1
      // supervisor (Haiku wrap) can subscribe to validate the policy decision.
      expect(migratorSource).toMatch(/this\.emit\(\s*'quota-force-kill-decision'/);
      // The payload names enough inputs to reproduce the decision.
      const eventBlock = migratorSource.match(/'quota-force-kill-decision'[\s\S]*?\}\);/);
      expect(eventBlock).toBeTruthy();
      const body = eventBlock![0];
      expect(body).toContain('currentUsagePct');
      expect(body).toContain('softCheckActive');
    });

    it('QuotaManager wires terminateSession + isBuildOrAutonomousActive + quotaUsagePercent', () => {
      expect(quotaManagerSource).toMatch(/terminateSession:\s*\(sessionId,\s*reason,\s*opts\)\s*=>\s*\n?\s*sm\.terminateSession/);
      expect(quotaManagerSource).toMatch(/isBuildOrAutonomousActive:\s*\(\)\s*=>\s*isBuildOrAutonomousActiveNow/);
      expect(quotaManagerSource).toContain('quotaUsagePercent:');
    });
  });

  describe('Bonus — session label follows topic rename', () => {
    const sessionManagerSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/SessionManager.ts'),
      'utf-8',
    );
    const telegramSource = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );
    const serverSource = fs.readFileSync(
      path.join(process.cwd(), 'src/commands/server.ts'),
      'utf-8',
    );

    it('SessionManager.renameSessionByTmux mutates ONLY the display name (never tmuxSession or id)', () => {
      const fn = sessionManagerSource.match(/renameSessionByTmux\([^)]*\)[\s\S]*?\n {2}\}/);
      expect(fn, 'method must exist').toBeTruthy();
      const body = fn![0];
      expect(body).toMatch(/session\.name\s*=\s*trimmed/);
      // Defensive: the method MUST NOT touch tmuxSession or id.
      expect(body).not.toMatch(/session\.tmuxSession\s*=/);
      expect(body).not.toMatch(/session\.id\s*=/);
    });

    it('TelegramAdapter fires the handler on TRUE rename — not on initial-capture / creation', () => {
      expect(telegramSource).toContain('setTopicRenamedHandler');
      // The fire site is gated on isRename, which requires forum_topic_edited
      // (rename event) AND name != currentName.
      expect(telegramSource).toMatch(/isRename\s*=\s*!!msg\.forum_topic_edited\?\.name\s*&&\s*currentName\s*!==\s*detectedName/);
      expect(telegramSource).toMatch(/if\s*\(isRename\s*&&\s*this\.topicRenamedHandler\)/);
    });

    it('server.ts wires the handler to update the BOUND session only via tmuxSession lookup', () => {
      expect(serverSource).toMatch(/setTopicRenamedHandler\(\(topicId, newName\)/);
      expect(serverSource).toMatch(/telegram\?\.getSessionForTopic\(topicId\)/);
      expect(serverSource).toContain('sessionManager.renameSessionByTmux');
    });
  });
});
