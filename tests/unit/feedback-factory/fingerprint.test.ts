/**
 * Unit tests (Tier 1) — feedback-factory fingerprint port (scar b).
 *
 * Behavioral + both-sides-of-boundary coverage that runs in CI (no reference
 * checkout needed). Byte-exact equivalence to the reference Python is proven
 * separately by the local parity harness (scripts/feedback-factory/
 * fingerprint-parity.mjs). The golden-value assertions below also anchor the
 * exact output so a regex/encoding regression fails here, not just in parity.
 */

import { describe, it, expect } from 'vitest';
import { computeFingerprint, extractComponent } from '../../../src/feedback-factory/processor/fingerprint.js';

describe('extractComponent', () => {
  it('extracts a dotted identifier, lowercased', () => {
    expect(extractComponent('GitSync.pull fails')).toBe('gitsync.pull');
    expect(extractComponent('StateManager.listSessions returns stale')).toBe('statemanager.listsessions');
    expect(extractComponent('Component.sub.deep.path works')).toBe('component.sub.deep.path');
  });

  it('falls back to the first word when there is no dotted identifier', () => {
    expect(extractComponent('lowercase already and simple')).toBe('lowercase');
  });

  it('strips a leading [TAG] prefix', () => {
    expect(extractComponent('[DEGRADATION] StateManager.listSessions timeout')).toBe('statemanager.listsessions');
    expect(extractComponent('[ALERT] GitSync.pull deadlock')).toBe('gitsync.pull');
  });

  it('strips ONLY whitelisted severity prefixes (both sides of the boundary)', () => {
    // Whitelisted single-word prefix → stripped, component is what follows.
    expect(extractComponent('CRITICAL: GitSync.pull broke')).toBe('gitsync.pull');
    // Whitelisted multi-word phrase → stripped.
    expect(extractComponent('VERIFIED FIX: GitSync.pull race')).toBe('gitsync.pull');
    // NON-whitelisted uppercase-colon → NOT stripped; first word wins ("notaseverity").
    expect(extractComponent('NOTASEVERITY: should not be stripped')).toBe('notaseverity');
  });

  it('returns "" for an empty title', () => {
    expect(extractComponent('')).toBe('');
  });
});

describe('computeFingerprint', () => {
  it('is a 32-char lowercase hex string', () => {
    const fp = computeFingerprint('bug', 'GitSync.pull fails');
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('collapses version differences to the SAME fingerprint (the core dedup behavior)', () => {
    const a = computeFingerprint('bug', 'auth token refresh broken in v1.1.0');
    const b = computeFingerprint('bug', 'auth token refresh broken in v1.1.1');
    const c = computeFingerprint('bug', 'auth token refresh broken in v2.13.4-beta.2');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('collapses bare integers and long hex hashes (so transient numbers do not fork a bug)', () => {
    const a = computeFingerprint('bug', 'retry 5 times then 12 failures at 300 seconds');
    const b = computeFingerprint('bug', 'retry 9 times then 1 failures at 7 seconds');
    expect(a).toBe(b);
    const h1 = computeFingerprint('bug', 'commit abc123def4567890 broke the build');
    const h2 = computeFingerprint('bug', 'commit deadbeefcafe1234 broke the build');
    expect(h1).toBe(h2);
  });

  it('collapses irregular INTERNAL whitespace', () => {
    // Both start with a word (so component extraction agrees); only internal
    // spacing differs → same fingerprint after the \s+ collapse.
    const a = computeFingerprint('bug', 'Title   With    Irregular     Spacing');
    const b = computeFingerprint('bug', 'Title With Irregular Spacing');
    expect(a).toBe(b);
  });

  it('leading whitespace changes component extraction (start-anchored) — NOT equal to the trimmed form', () => {
    // Documents a real reference behavior: extract_component runs on the RAW
    // title and is start-anchored, so a leading space yields an empty component.
    const leading = computeFingerprint('bug', '   Title With Spacing');
    const trimmed = computeFingerprint('bug', 'Title With Spacing');
    expect(leading).not.toBe(trimmed);
  });

  it('is case-insensitive on the title', () => {
    expect(computeFingerprint('bug', 'GitSync.pull FAILS')).toBe(computeFingerprint('bug', 'gitsync.pull fails'));
  });

  it('incorporates TYPE (not just the title) — different type → different fingerprint', () => {
    expect(computeFingerprint('bug', 'same title here')).not.toBe(computeFingerprint('feature', 'same title here'));
  });

  it('incorporates COMPONENT — an explicit component changes the fingerprint vs the extracted one', () => {
    const extracted = computeFingerprint('bug', 'GitSync.pull fails');
    const explicit = computeFingerprint('bug', 'GitSync.pull fails', 'Other.Component');
    expect(extracted).not.toBe(explicit);
  });

  it('golden values match the reference Python (CI regression anchor for the byte-exact port)', () => {
    // Captured from the reference the-portal/.claude/scripts/feedback-processor.py
    // and verified 33/33 byte-identical by scripts/feedback-factory/fingerprint-parity.mjs.
    // A regex/encoding regression that the parity harness would catch locally also
    // fails HERE, in CI, where the reference checkout isn't available.
    expect(computeFingerprint('bug', 'GitSync.pull fails intermittently')).toBe('73d3a2ef996158a7840e0c13bc9ad0aa');
    expect(computeFingerprint('bug', 'auth token refresh broken in v1.1.0')).toBe('fb4e06c3382b9b74670ac7d5deeccfdc');
    expect(computeFingerprint('feature', '[DEGRADATION] StateManager.listSessions timeout')).toBe('0f91b0a2fc80c384b1a22e3d24b49315');
  });
});
