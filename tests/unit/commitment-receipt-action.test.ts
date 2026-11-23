import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/commitment-receipt-action.test.ts' }); });
const intent = { title: 'Send the promised comparison', description: 'Review the same source message once.',
  followThroughOptOutReason: 'No concrete due time was stated.',
  source: { platform: 'commitment-detection', contentId: `cf1:${'a'.repeat(64)}:0` } };
function make() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-action-')); dirs.push(dir); return { dir, manager: new EvolutionManager({ stateDir: dir }) }; }

describe('reserved commitment receipt action registration', () => {
  it('reuses exact intent after crash/restart instead of creating a second action', () => {
    const { dir, manager } = make(); manager.setCommitmentReceiptModeProvider(() => true);
    const first = manager.addAction(intent);
    const restarted = new EvolutionManager({ stateDir: dir }); restarted.setCommitmentReceiptModeProvider(() => true);
    expect(restarted.addAction(intent).id).toBe(first.id);
    expect(restarted.listActions()).toHaveLength(1);
    expect(() => restarted.addAction({ ...intent, title: 'A different interpretation' })).toThrow(/conflict/);
  });
  it('refuses reserved writes while off or unavailable; ordinary creation stays unchanged', () => {
    const { manager } = make();
    expect(() => manager.addAction(intent)).toThrow(/receipt mode/);
    manager.setCommitmentReceiptModeProvider(() => true); manager.addAction(intent);
    manager.setCommitmentReceiptModeProvider(() => false);
    expect(() => manager.addAction(intent)).toThrow(/receipt mode/);
    expect(manager.addAction({ ...intent, source: { platform: 'ordinary' } }).id).toBeTruthy();
  });
  it('the strict view preserves records the title/recipient/time replication map would collapse', () => {
    const { dir, manager } = make();
    const file = path.join(dir, 'state', 'evolution', 'action-queue.json');
    manager.addAction({ ...intent, source: { platform: 'ordinary' } });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.actions.push({ ...stored.actions[0], id: 'ACT-999', source: { platform: 'other' } });
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(manager.listCommitmentReceiptActions()).toHaveLength(2);
  });
});

describe('archived receipt registrations', () => {
  it('reuses an archived action across restart and refuses an unreadable archive', () => {
    const { dir, manager } = make(); manager.setCommitmentReceiptModeProvider(() => true);
    const first = manager.addAction(intent); manager.updateAction(first.id, { status: 'completed' });
    const terminal = manager.listActions()[0];
    manager.archive.write({ ...manager.archive.read(), entries: [{ action: terminal, archivedAt: new Date().toISOString(), ageDays: 1, class: 'retention' }] });
    const file = path.join(dir, 'state', 'evolution', 'action-queue.json'); const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.actions = []; fs.writeFileSync(file, JSON.stringify(stored));
    const restarted = new EvolutionManager({ stateDir: dir }); restarted.setCommitmentReceiptModeProvider(() => true);
    expect(restarted.addAction(intent).id).toBe(first.id); expect(restarted.listActions()).toHaveLength(0);
    fs.writeFileSync(restarted.archive.filePath, '{broken');
    expect(() => restarted.addAction(intent)).toThrow(); expect(restarted.listActions()).toHaveLength(0);
  });
});
