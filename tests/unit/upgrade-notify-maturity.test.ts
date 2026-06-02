/**
 * Unit/behavior tests — UpgradeNotifyManager maturity-aware prompt
 * (mature-update-announcements spec, D2).
 *
 * Asserts the silent-by-default flip and the maturity framing at the prompt
 * boundary (the prompt IS the contract handed to the notify session):
 *   - no user-facing entry ⇒ Step 1 is a SKIP, and the old "lead with the
 *     biggest USER-VISIBLE feature" instruction is gone.
 *   - a user-facing experimental entry ⇒ the prompt carries the announcement
 *     brief + the experimental badge/caveat, and composes ONLY from it.
 * The fact that the brief reflects the guide's front-matter is the wiring proof
 * that buildPrompt actually invokes the real parser (not a stub).
 */

import { describe, it, expect } from 'vitest';
import { UpgradeNotifyManager, type UpgradeNotifyConfig } from '../../src/core/UpgradeNotifyManager.js';

function makeManager(): UpgradeNotifyManager {
  const config: UpgradeNotifyConfig = {
    pendingGuidePath: '/tmp/does-not-matter.md',
    projectDir: '/tmp/proj',
    stateDir: '/tmp/proj/.instar',
    port: 4040,
    dashboardPin: '123456',
    tunnelUrl: '',
    currentVersion: '1.4.0',
    replyScript: '/tmp/proj/.instar/scripts/telegram-reply.sh',
    notifyTopicId: 42,
  };
  return new UpgradeNotifyManager(
    config,
    async () => ({ id: 's1' }) as any,
    () => true,
    () => {},
  );
}

const OLD_LEAD_LINE = 'Lead with the biggest USER-VISIBLE feature';

describe('UpgradeNotifyManager.buildPrompt — silent by default', () => {
  it('emits a SKIP Step 1 when the guide has no user-facing announcement', () => {
    const mgr = makeManager();
    const guide = [
      '---',
      'user_announcement:',
      '  - audience: agent-only',
      '    maturity: experimental',
      '    headline: Internal plumbing',
      '    body: infra only',
      '---',
      '# Upgrade Guide',
      '',
      '## Summary of New Capabilities',
      '- internal stuff',
    ].join('\n');

    const prompt = mgr.buildPrompt(guide);
    expect(prompt).toContain('## Step 1: Notify your user — SKIP');
    expect(prompt).toContain('Do NOT send the user any message');
    // The old maturity-blind instruction must be gone.
    expect(prompt).not.toContain(OLD_LEAD_LINE);
    // Steps 2 & 3 still run — the agent still LEARNS the capability.
    expect(prompt).toContain('## Step 2: Update your memory');
    expect(prompt).toContain('## Step 3: Acknowledge');
  });

  it('emits a SKIP Step 1 when the guide has NO front-matter at all', () => {
    const mgr = makeManager();
    const prompt = mgr.buildPrompt('# Upgrade Guide\n\n## Summary of New Capabilities\n- a thing');
    expect(prompt).toContain('## Step 1: Notify your user — SKIP');
    expect(prompt).not.toContain(OLD_LEAD_LINE);
  });
});

describe('UpgradeNotifyManager.buildPrompt — maturity-framed announcement', () => {
  it('injects the experimental brief and drops the old lead instruction', () => {
    const mgr = makeManager();
    const guide = [
      '---',
      'user_announcement:',
      '  - audience: user',
      '    maturity: experimental',
      '    headline: Early Gemini CLI support',
      '    body: landing piece by piece',
      '---',
      '# Upgrade Guide',
      '',
      '## Summary of New Capabilities',
      '- gemini wizard',
    ].join('\n');

    const prompt = mgr.buildPrompt(guide);
    expect(prompt).toContain('## Step 1: Notify your user');
    expect(prompt).not.toContain('— SKIP');
    expect(prompt).not.toContain(OLD_LEAD_LINE);
    // Wiring proof: the brief reflects the parsed front-matter entry.
    expect(prompt).toContain('Early Gemini CLI support');
    expect(prompt).toContain('⚗️ Experimental');
    expect(prompt.toLowerCase()).toContain('not ready for general use');
    expect(prompt).toContain('compose only from these');
    // The detailed guide body is still appended for the memory step.
    expect(prompt).toContain('--- UPGRADE GUIDE ---');
    expect(prompt).toContain('gemini wizard');
  });

  it('uses the Preview badge for a preview entry', () => {
    const mgr = makeManager();
    const guide = [
      '---',
      'user_announcement:',
      '  - audience: user',
      '    maturity: preview',
      '    headline: New report view',
      '    body: try it out',
      '---',
      '# guide',
    ].join('\n');
    const prompt = mgr.buildPrompt(guide);
    expect(prompt).toContain('🧪 Preview');
    expect(prompt).toContain('New report view');
  });
});
