import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuleResponseLedger } from '../../src/messaging/RuleResponseLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('per-rule response escalation', () => {
  let directory: string;
  let ledger: RuleResponseLedger;
  const digest = 'a'.repeat(64);

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-response-'));
    ledger = new RuleResponseLedger(path.join(directory, 'responses.db'));
  });
  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'rule response fixture cleanup' });
  });

  it('counts confirmed unique messages per rule and persists one scoped override', () => {
    const finding = (rule: string, message: number, confirmed = true) =>
      ledger.recordFinding({ rule, topic: 1, message, confirmed });
    expect(finding('ask-links', 1)).toMatchObject({ total: 1, action: 'learning-note' });
    expect(finding('ask-links', 1)).toMatchObject({ total: 1, added: false });
    expect(finding('ask-links', 2, false)).toMatchObject({ total: 1, added: false });
    expect(finding('ask-links', 3)).toMatchObject({ total: 2, action: 'targeted-reminder' });
    expect(finding('other-rule', 3)).toMatchObject({ total: 1, action: 'learning-note' });
    expect(() => ledger.recordOverride('ask-links', 1, digest, 'The link is provided separately.')).toThrow('has not reached');
    expect(finding('ask-links', 5)).toMatchObject({ total: 3, action: 'draft-check' });
    expect(() => ledger.recordOverride('ask-links', 1, digest, ' ')).toThrow('reason required');
    const reason = 'The recipient already has the exact link.';
    expect(ledger.recordOverride('ask-links', 1, digest, reason)).toMatchObject({ overrideReason: reason });
    ledger.close();
    ledger = new RuleResponseLedger(path.join(directory, 'responses.db'));
    expect(ledger.draftResponse('ask-links', 1, digest)).toMatchObject({ action: 'draft-check', overrideReason: reason });
    expect(ledger.draftResponse('ask-links', 2, digest).overrideReason).toBeNull();
    expect(ledger.draftResponse('ask-links', 1, 'b'.repeat(64)).overrideReason).toBeNull();
  });
});
