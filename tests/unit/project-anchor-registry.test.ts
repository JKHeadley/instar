// safe-fs-allow: test file — temp dirs only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createProjectAnchorLookup, createStandingProjectAnchorLookup, type ApprovedProjectAnchor } from '../../src/core/ProjectAnchorRegistry.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import { createProjectPurposePilotReader, projectPurposeDesignationDigest } from '../../src/core/ProjectPurposePilot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const chief = { id: 'chief-of-staff', kind: 'project', status: 'active', telegramTopicId: '141385' } as Initiative;
const context = { id: 'context-budget', kind: 'project', status: 'active', telegramTopicId: '141133' } as Initiative;
const anchor: ApprovedProjectAnchor = {
  revision: 1, purpose: 'Fixture purpose',
  sourceMessages: [{ conversationKey: 'telegram:141385', messageId: '101', at: '2026-11-26T22:00:00Z' }],
  done: [{ id: 'fold', text: 'Fold one long conversation', state: 'open' }],
  outOfScope: [{ text: 'Benchmark extension', ownedByProjectId: 'real-scenario-benchmark' }],
};

describe('read-only project anchor lookup', () => {
  it('requires an approved revision on one exact active project', () => {
    const readApproved = vi.fn((project: Initiative) => project.id === 'context-budget' ? anchor : null);
    const read = createProjectAnchorLookup({ listProjects: () => [chief, context], readApproved });
    expect(read('telegram:141133')).toEqual({ status: 'resolved', projectId: 'context-budget', anchor });
    expect(readApproved).toHaveBeenCalledWith(context, 'telegram:141133');
    expect(read('telegram:141385')).toEqual({ status: 'missing' });
    expect(read('app:141133')).toEqual({ status: 'missing' });
  });

  it('refuses ambiguity without reading an approved revision', () => {
    const readApproved = vi.fn(() => anchor);
    const impostor = { ...chief, telegramTopicId: context.telegramTopicId };
    const read = createProjectAnchorLookup({ listProjects: () => [impostor, context], readApproved });
    expect(read('telegram:141133')).toEqual({ status: 'ambiguous' });
    expect(readApproved).not.toHaveBeenCalled();
  });
});

it('admits only the release-bound original wording from a private local pilot file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-purpose-pilot-'));
  try {
    const purpose = 'Fixture purpose, exactly as written.';
    const row = { fromUser: true, forwarded: false, telegramUserId: 123, timestamp: '2026-11-26T22:00:00.000Z', text: purpose };
    let owner = 123;
    const history = { getVerifiedOwner: () => owner, findTopicMessage: vi.fn(() => ({ entry: row })) };
    const item = {
      projectId: context.id, conversationKey: 'telegram:141133',
      source: { ...anchor.sourceMessages[0]!, at: row.timestamp },
      purposeSha256: createHash('sha256').update(purpose).digest('hex'),
    };
    const machine = 'fixture-studio';
    const digest = projectPurposeDesignationDigest(machine, 123, item);
    const readPilot = () => createProjectPurposePilotReader(dir, history, machine, digest)(context, item.conversationKey);
    const designation = path.join(dir, 'state', 'project-purpose-pilot.json');
    const actualFile = path.join(dir, 'designation.json');
    fs.mkdirSync(path.dirname(designation));
    expect(readPilot()).toBeNull();
    fs.writeFileSync(actualFile, JSON.stringify(item), { mode: 0o600 });
    fs.symlinkSync(actualFile, designation);
    expect(readPilot()).toBeNull();
    SafeFsExecutor.safeUnlinkSync(designation, { operation: 'tests/unit/project-anchor-registry.test.ts' });
    fs.writeFileSync(designation, JSON.stringify(item), { mode: 0o644 });
    expect(readPilot()).toBeNull();
    fs.chmodSync(designation, 0o600);
    const encoded = JSON.stringify(item);
    fs.writeFileSync(designation, encoded.padEnd(2049, ' '));
    expect(readPilot()).toBeNull();
    fs.writeFileSync(designation, JSON.stringify({ ...item, purposeSha256: 'a'.repeat(64) }));
    expect(readPilot()).toBeNull();
    fs.writeFileSync(designation, encoded.padEnd(2048, ' '));
    const wrongMachine = createProjectPurposePilotReader(dir, history, 'fixture-mini', digest);
    expect(wrongMachine(context, item.conversationKey)).toBeNull();
    expect(createProjectPurposePilotReader(dir, history, machine)(context, item.conversationKey)).toBeNull();
    expect(history.findTopicMessage).not.toHaveBeenCalled();
    const warmed = createProjectPurposePilotReader(dir, history, machine, digest);
    const expected = { projectId: item.projectId, conversationKey: item.conversationKey, source: item.source, purpose };
    expect(warmed(context, item.conversationKey)).toEqual(expected);
    expect(warmed(context, item.conversationKey)).toEqual(expected);
    expect(history.findTopicMessage).toHaveBeenCalledTimes(1);
    owner = 456;
    expect(warmed(context, item.conversationKey)).toBeNull();
    row.telegramUserId = 456;
    expect(readPilot()).toBeNull();
    expect(history.findTopicMessage).toHaveBeenCalledTimes(1);
    row.telegramUserId = 123;
    owner = 123;
    row.text = 'A different message body';
    expect(readPilot()).toBeNull();
    row.text = purpose;
    row.forwarded = true;
    expect(readPilot()).toBeNull();
    row.forwarded = false;
    fs.writeFileSync(path.join(dir, 'state', 'project-purpose-pilot.retired'), '', { mode: 0o600 });
    fs.writeFileSync(designation, encoded);
    expect(warmed(context, item.conversationKey)).toBeNull();
    expect(readPilot()).toBeNull();
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/project-anchor-registry.test.ts' });
  }
});

describe('proposed project purpose', () => {
  const conversationKey = 'telegram:141133';
  const proposal = {
    projectId: context.id, conversationKey, purpose: 'Use fewer tokens and keep the context.',
    source: anchor.sourceMessages[0]!,
  };

  it('returns only the advisory purpose and source for the assigned project', () => {
    const inputs = {
      listProjects: () => [chief, context],
      readApproved: () => null,
      readVerifiedProposal: () => proposal,
    };
    const lookup = createStandingProjectAnchorLookup(inputs);
    expect(lookup(conversationKey)).toEqual({
      status: 'proposed', projectId: context.id, purpose: proposal.purpose, source: proposal.source,
    });
    expect(lookup('telegram:141385')).toEqual({ status: 'missing' });
    expect(createProjectAnchorLookup(inputs)(conversationKey)).toEqual({ status: 'missing' });
  });

  it('keeps a confirmed anchor ahead of any outstanding proposal', () => {
    const readVerifiedProposal = vi.fn(() => proposal);
    const lookup = createStandingProjectAnchorLookup({
      listProjects: () => [context], readApproved: () => anchor, readVerifiedProposal,
    });
    expect(lookup(conversationKey)).toEqual({ status: 'resolved', projectId: context.id, anchor });
    expect(readVerifiedProposal).not.toHaveBeenCalled();
  });

  it('does not replay the initial proposal after an earlier confirmed revision was cleared', () => {
    const readVerifiedProposal = vi.fn(() => proposal);
    const lookup = createStandingProjectAnchorLookup({
      listProjects: () => [{ ...context, approvedProjectAnchorRevision: 2 }],
      readApproved: () => null,
      readVerifiedProposal,
    });
    expect(lookup(conversationKey)).toEqual({ status: 'missing' });
    expect(readVerifiedProposal).not.toHaveBeenCalled();
  });
});
