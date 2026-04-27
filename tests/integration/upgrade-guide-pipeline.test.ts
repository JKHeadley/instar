/**
 * Integration tests — Upgrade guide delivery pipeline.
 *
 * Tests the complete flow from versioned guide files through
 * UpgradeGuideProcessor to the pending file that triggers
 * UpgradeNotifyManager.
 *
 * This covers the exact failure category: a guide existing on disk
 * but never reaching the agent because of pipeline gaps.
 *
 * Coverage:
 *   1. Full pipeline: versioned guide → processor → pending file → ready for notify
 *   2. NEXT.md is ignored by the processor (only versioned files delivered)
 *   3. Newer version replaces older pending guide
 *   4. Multiple sequential updates deliver each guide once
 *   5. Pipeline recovery: guide preserved after failed notification
 *   6. upgrade-ack clears the pending guide
 *   7. Re-processing after ack finds nothing new
 *   8. Cross-version delivery: only guides between old and new version
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpgradeGuideProcessor } from '../../src/core/UpgradeGuideProcessor.js';
import {
  UpgradeNotifyManager,
  type UpgradeNotifyConfig,
} from '../../src/core/UpgradeNotifyManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Upgrade guide delivery pipeline', () => {
  let tmpDir: string;
  let stateDir: string;
  let upgradesDir: string;

  const GUIDE_V85 = `# Upgrade Guide — v0.9.85

## What Changed
Added inter-agent messaging with delivery tracking and safe tmux injection.

## What to Tell Your User
- **Sessions can talk to each other**: "My sessions coordinate instead of working blind."

## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Send messages | POST /messages/send |
| Acknowledge | POST /messages/ack |
`;

  const GUIDE_V86 = `# Upgrade Guide — v0.9.86

## What Changed
Added hybrid search combining keyword and vector, plus MEMORY.md export from semantic knowledge.

## What to Tell Your User
- **Better search**: "I find things more reliably with combined keyword and semantic search."
- **Richer memory**: "My MEMORY.md now reflects my full knowledge graph."

## Summary of New Capabilities
| Capability | How to Use |
|-----------|-----------|
| Hybrid search | POST /semantic/search with alpha |
| Memory export | POST /semantic/export-memory |
`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
    stateDir = path.join(tmpDir, '.instar');
    upgradesDir = path.join(tmpDir, 'upgrades');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(upgradesDir, { recursive: true });
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/upgrade-guide-pipeline.test.ts:78' });
  });

  function createProcessor(opts: {
    currentVersion?: string;
    previousVersion?: string;
  } = {}): UpgradeGuideProcessor {
    const proc = new UpgradeGuideProcessor({
      stateDir,
      currentVersion: opts.currentVersion ?? '0.9.86',
      previousVersion: opts.previousVersion,
    });
    // @ts-expect-error — testing private method override
    proc.findUpgradesDir = () => upgradesDir;
    return proc;
  }

  function writeGuide(version: string, content: string) {
    fs.writeFileSync(path.join(upgradesDir, `${version}.md`), content);
  }

  const pendingPath = () => path.join(stateDir, 'state', 'pending-upgrade-guide.md');

  // 1. Full pipeline
  it('delivers versioned guide through full pipeline to pending file', () => {
    writeGuide('0.9.86', GUIDE_V86);

    const proc = createProcessor({ previousVersion: '0.9.85' });
    const result = proc.process();

    expect(result.pendingGuides).toContain('0.9.86');
    expect(result.pendingGuidePath).toBeTruthy();
    expect(fs.existsSync(pendingPath())).toBe(true);

    const content = fs.readFileSync(pendingPath(), 'utf-8');
    expect(content).toContain('hybrid search');
    expect(content).toContain('MEMORY.md export');
  });

  // 2. NEXT.md ignored
  it('NEXT.md is not delivered as an upgrade guide', () => {
    // Clean state
    if (fs.existsSync(pendingPath())) SafeFsExecutor.safeUnlinkSync(pendingPath(), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:121' });
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:124' });

    // Only write NEXT.md (no versioned file)
    fs.writeFileSync(path.join(upgradesDir, 'NEXT.md'), `# Next Guide
## What Changed
Something new.
## What to Tell Your User
- New thing.
## Summary of New Capabilities
| Cap | Use |
|-----|-----|
| New | automatic |
`);

    // Remove versioned guides
    for (const f of fs.readdirSync(upgradesDir)) {
      if (/^\d+\.\d+\.\d+\.md$/.test(f)) {
        SafeFsExecutor.safeUnlinkSync(path.join(upgradesDir, f), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:142' });
      }
    }

    const proc = createProcessor();
    const result = proc.process();

    expect(result.pendingGuides).toEqual([]);
    expect(result.guideContent).toBe('');
  });

  // 3. Cross-version delivery
  it('delivers only guides between previousVersion and currentVersion', () => {
    // Clean state
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:158' });
    if (fs.existsSync(pendingPath())) SafeFsExecutor.safeUnlinkSync(pendingPath(), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:160' });

    writeGuide('0.9.80', `# Guide v0.9.80
## What Changed
Old feature.
## What to Tell Your User
- Old.
## Summary of New Capabilities
| Cap | Use |
|-----|-----|
| Old | manual |
`);
    writeGuide('0.9.85', GUIDE_V85);
    writeGuide('0.9.86', GUIDE_V86);

    // Agent upgrading from 0.9.84 → 0.9.86
    const proc = createProcessor({
      currentVersion: '0.9.86',
      previousVersion: '0.9.84',
    });
    const result = proc.process();

    // Should get 0.9.85 and 0.9.86 but NOT 0.9.80
    expect(result.pendingGuides).toContain('0.9.85');
    expect(result.pendingGuides).toContain('0.9.86');
    expect(result.pendingGuides).not.toContain('0.9.80');
  });

  // 4. upgrade-ack clears pending guide
  it('upgrade-ack (clearPendingGuide) removes the pending file', () => {
    // Clean state
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:193' });

    writeGuide('0.9.86', GUIDE_V86);

    const proc = createProcessor({ previousVersion: '0.9.85' });
    proc.process();

    expect(proc.hasPendingGuide()).toBe(true);

    proc.clearPendingGuide();

    expect(proc.hasPendingGuide()).toBe(false);
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  // 5. Re-processing after ack finds nothing new
  it('after ack, re-processing finds nothing new (guides marked as processed)', () => {
    // Clean state
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:213' });

    writeGuide('0.9.86', GUIDE_V86);

    const proc = createProcessor({ previousVersion: '0.9.85' });
    proc.process();
    proc.clearPendingGuide();

    // Re-process — should find nothing
    const proc2 = createProcessor({ previousVersion: '0.9.85' });
    const result = proc2.process();

    expect(result.pendingGuides).toEqual([]);
    expect(result.alreadyProcessed).toContain('0.9.86');
  });

  // 6. Pipeline recovery: guide preserved after notification session failure
  it('pending guide survives failed notification (not deleted by processor)', async () => {
    // Clean state
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:234' });

    writeGuide('0.9.86', GUIDE_V86);

    const proc = createProcessor({ previousVersion: '0.9.85' });
    proc.process();

    expect(fs.existsSync(pendingPath())).toBe(true);

    // Simulate a FAILED notification (session completes but doesn't ack)
    const notifyConfig: UpgradeNotifyConfig = {
      pendingGuidePath: pendingPath(),
      projectDir: tmpDir,
      stateDir,
      port: 3000,
      dashboardPin: '',
      tunnelUrl: '',
      currentVersion: '0.9.86',
      replyScript: '',
      notifyTopicId: 0,
    };

    const sessionsComplete = new Set<string>();
    let sessionCount = 0;

    const manager = new UpgradeNotifyManager(
      notifyConfig,
      async ({ name, prompt, model }) => {
        sessionCount++;
        const id = `fail-session-${sessionCount}`;
        sessionsComplete.add(id);
        // Session completes but does NOT delete the pending guide
        return {
          id,
          name,
          status: 'running' as const,
          tmuxSession: `tmux-${id}`,
          startedAt: new Date().toISOString(),
          model,
          prompt,
        };
      },
      (sessionId) => sessionsComplete.has(sessionId),
      () => {}, // no-op logger
      { sessionTimeoutMs: 500, pollIntervalMs: 50, postCompletionDelayMs: 10 },
    );

    const result = await manager.notify();
    expect(result.success).toBe(false);

    // The pending guide should STILL exist for next session-start
    expect(fs.existsSync(pendingPath())).toBe(true);
  });

  // 7. Multiple sequential updates deliver each once
  it('sequential version bumps each deliver their own guide exactly once', () => {
    // Clean ALL state including guide files from previous tests
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:293' });
    if (fs.existsSync(pendingPath())) SafeFsExecutor.safeUnlinkSync(pendingPath(), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:295' });
    for (const f of fs.readdirSync(upgradesDir)) {
      SafeFsExecutor.safeUnlinkSync(path.join(upgradesDir, f), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:298' });
    }

    // First update: 0.9.84 → 0.9.85
    writeGuide('0.9.85', GUIDE_V85);
    const proc1 = createProcessor({ currentVersion: '0.9.85', previousVersion: '0.9.84' });
    const result1 = proc1.process();
    expect(result1.pendingGuides).toEqual(['0.9.85']);
    proc1.clearPendingGuide();

    // Second update: 0.9.85 → 0.9.86
    writeGuide('0.9.86', GUIDE_V86);
    const proc2 = createProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    const result2 = proc2.process();
    expect(result2.pendingGuides).toEqual(['0.9.86']);
    // Note: 0.9.85 isn't in alreadyProcessed because previousVersion filter
    // excludes it before the processed check — it never enters the comparison.
    // This is correct: proc2 only cares about guides > 0.9.85.
    proc2.clearPendingGuide();

    // Third check — nothing new
    const proc3 = createProcessor({ currentVersion: '0.9.86', previousVersion: '0.9.85' });
    const result3 = proc3.process();
    expect(result3.pendingGuides).toEqual([]);
  });

  // 8. Pending guide content includes header with count
  it('pending guide includes header with guide count', () => {
    // Clean ALL state including guide files from previous tests
    const processedFile = path.join(stateDir, 'state', 'processed-upgrades.json');
    if (fs.existsSync(processedFile)) SafeFsExecutor.safeUnlinkSync(processedFile, { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:329' });
    if (fs.existsSync(pendingPath())) SafeFsExecutor.safeUnlinkSync(pendingPath(), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:331' });
    for (const f of fs.readdirSync(upgradesDir)) {
      SafeFsExecutor.safeUnlinkSync(path.join(upgradesDir, f), { operation: 'tests/integration/upgrade-guide-pipeline.test.ts:334' });
    }

    writeGuide('0.9.85', GUIDE_V85);
    writeGuide('0.9.86', GUIDE_V86);

    const proc = createProcessor({ previousVersion: '0.9.84' });
    const result = proc.process();

    expect(result.guideContent).toContain('2 upgrade guides to process');
    expect(result.guideContent).toContain('IMPORTANT');
  });
});
