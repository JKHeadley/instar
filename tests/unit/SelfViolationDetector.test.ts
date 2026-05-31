/**
 * Unit tests — SelfViolationDetector (Self-Violation Signal extension).
 *
 * Contract pinned (the build's deliverable §7 unit list):
 *   - violating text → detected; clean text → not detected
 *   - a lone weak/ambiguous keyword NEVER fires (precision over recall)
 *   - an absent `violationPattern` → that preference is skipped (back-compat)
 *   - never throws (malformed regex, bad input, null/undefined args)
 *   - regex AND keyword pattern grammars both work; bare source = regex
 *   - PreferencesManager schema back-compat: violationPattern round-trips,
 *     and a file written WITHOUT the field reads cleanly (no check).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectSelfViolation } from '../../src/monitoring/SelfViolationDetector.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import type { PreferenceEntry } from '../../src/core/PreferencesManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function pref(partial: Partial<PreferenceEntry>): PreferenceEntry {
  return {
    learning: partial.learning ?? 'a learned preference',
    provenance: 'correction-loop',
    dedupeKey: partial.dedupeKey ?? 'user-preference:abc',
    recordedAt: partial.recordedAt ?? '2026-05-30T10:00:00.000Z',
    confidence: partial.confidence ?? 0.8,
    dedupeCount: partial.dedupeCount ?? 1,
    violationPattern: partial.violationPattern,
  };
}

describe('detectSelfViolation — core matching', () => {
  it('regex: a contradicting message is detected', () => {
    const p = pref({
      learning: "don't defer work to a fresh session — there is no tail of a session",
      violationPattern: 'regex:fresh session|next session|pick this up later',
    });
    const out = detectSelfViolation(
      "I'll pause here and pick this up later in a fresh session to keep context clean.",
      [p],
    );
    expect(out).toHaveLength(1);
    expect(out[0].preference.dedupeKey).toBe(p.dedupeKey);
    expect(out[0].matchKind).toBe('regex');
    // The matched substring is one of the pattern's alternatives (whichever
    // occurs first in the message — here "pick this up later").
    expect(out[0].matchedText.toLowerCase()).toContain('pick this up later');
  });

  it('regex: a clean message is NOT detected', () => {
    const p = pref({ violationPattern: 'regex:fresh session|next session' });
    const out = detectSelfViolation(
      "On it — building the fix now and I'll report back when it's merged.",
      [p],
    );
    expect(out).toHaveLength(0);
  });

  it('bare source is treated as a regex', () => {
    const p = pref({ violationPattern: 'never ask the user to edit' });
    const out = detectSelfViolation('Could you never ask the user to edit that file again?', [p]);
    expect(out).toHaveLength(1);
    expect(out[0].matchKind).toBe('regex');
  });

  it('regex matching is case-insensitive', () => {
    const p = pref({ violationPattern: 'regex:fresh session' });
    const out = detectSelfViolation('Let me start a FRESH SESSION for this.', [p]);
    expect(out).toHaveLength(1);
  });
});

describe('detectSelfViolation — keyword grammar (precision over recall)', () => {
  it('keywords: fires only when ALL keywords present', () => {
    const p = pref({ violationPattern: 'keywords:edit,file,yourself' });
    const hit = detectSelfViolation('Please edit the config file yourself and save it.', [p]);
    expect(hit).toHaveLength(1);
    expect(hit[0].matchKind).toBe('keywords');

    const miss = detectSelfViolation('Please edit the config yourself.', [p]); // no "file"
    expect(miss).toHaveLength(0);
  });

  it('a LONE weak keyword NEVER fires (single-keyword set is too weak)', () => {
    const p = pref({ violationPattern: 'keywords:fresh' });
    const out = detectSelfViolation('I picked up some fresh produce metaphorically speaking.', [p]);
    expect(out).toHaveLength(0); // single keyword is below the min-to-fire floor
  });

  it('two keywords both present but unrelated context still fires only on full presence', () => {
    const p = pref({ violationPattern: 'keywords:context,length' });
    const fires = detectSelfViolation('I should stop because of context length concerns.', [p]);
    expect(fires).toHaveLength(1);
    const noFire = detectSelfViolation('Here is some context for you.', [p]); // no "length"
    expect(noFire).toHaveLength(0);
  });
});

describe('detectSelfViolation — back-compat + skip semantics', () => {
  it('a preference WITHOUT a violationPattern is never checked (skipped)', () => {
    const noPattern = pref({ violationPattern: undefined });
    const out = detectSelfViolation('any text at all including fresh session', [noPattern]);
    expect(out).toHaveLength(0);
  });

  it('an empty / whitespace pattern is treated as no-check', () => {
    expect(detectSelfViolation('fresh session', [pref({ violationPattern: '' })])).toHaveLength(0);
    expect(detectSelfViolation('fresh session', [pref({ violationPattern: '   ' })])).toHaveLength(0);
  });

  it('mixed list: only the patterned preference fires', () => {
    const checked = pref({ dedupeKey: 'k1', violationPattern: 'regex:fresh session' });
    const unchecked = pref({ dedupeKey: 'k2', violationPattern: undefined });
    const out = detectSelfViolation('starting a fresh session', [checked, unchecked]);
    expect(out).toHaveLength(1);
    expect(out[0].preference.dedupeKey).toBe('k1');
  });

  it('multiple violations across distinct preferences are all returned', () => {
    const a = pref({ dedupeKey: 'a', violationPattern: 'regex:fresh session' });
    const b = pref({ dedupeKey: 'b', violationPattern: 'keywords:edit,file' });
    const out = detectSelfViolation('Start a fresh session and edit the file please.', [a, b]);
    expect(out.map((v) => v.preference.dedupeKey).sort()).toEqual(['a', 'b']);
  });
});

describe('detectSelfViolation — never throws (fail-open)', () => {
  it('an invalid regex source yields no detection, no throw', () => {
    const p = pref({ violationPattern: 'regex:([unterminated' });
    expect(() => detectSelfViolation('([unterminated text', [p])).not.toThrow();
    expect(detectSelfViolation('([unterminated text', [p])).toHaveLength(0);
  });

  it('null / undefined / empty args are handled', () => {
    expect(detectSelfViolation('', [pref({ violationPattern: 'regex:x' })])).toHaveLength(0);
    expect(detectSelfViolation('x', null)).toHaveLength(0);
    expect(detectSelfViolation('x', undefined)).toHaveLength(0);
    // @ts-expect-error — deliberately passing the wrong type to prove the guard
    expect(detectSelfViolation(123, [pref({ violationPattern: 'regex:x' })])).toHaveLength(0);
  });

  it('a list containing malformed entries does not throw', () => {
    const list = [
      // @ts-expect-error — deliberately malformed entry
      null,
      // @ts-expect-error — deliberately malformed entry
      'not-an-object',
      pref({ violationPattern: 'regex:fresh session' }),
    ] as PreferenceEntry[];
    expect(() => detectSelfViolation('fresh session', list)).not.toThrow();
    expect(detectSelfViolation('fresh session', list)).toHaveLength(1);
  });
});

describe('PreferencesManager schema back-compat for violationPattern', () => {
  it('recordPreference persists violationPattern and read() round-trips it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-prefs-'));
    try {
      const mgr = new PreferencesManager(dir);
      mgr.recordPreference({
        learning: "don't defer to a fresh session",
        dedupeKey: 'user-preference:fresh',
        confidence: 0.9,
        violationPattern: 'regex:fresh session',
      });
      const store = mgr.read();
      expect(store.preferences).toHaveLength(1);
      expect(store.preferences[0].violationPattern).toBe('regex:fresh session');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'svd-test' });
    }
  });

  it('a preferences file written WITHOUT violationPattern reads cleanly (no field)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-prefs-legacy-'));
    try {
      const file = path.join(dir, 'preferences.json');
      // Simulate a SHIPPED file from before the field existed.
      fs.writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          preferences: [
            {
              learning: 'lead with the one action',
              provenance: 'correction-loop',
              dedupeKey: 'user-preference:lead',
              recordedAt: '2026-05-01T00:00:00.000Z',
              confidence: 0.7,
              dedupeCount: 2,
            },
          ],
        }),
      );
      const mgr = new PreferencesManager(dir);
      const store = mgr.read();
      expect(store.preferences).toHaveLength(1);
      expect(store.preferences[0].violationPattern).toBeUndefined();
      // And such a preference is never self-violation-checked.
      expect(detectSelfViolation('any text', store.preferences)).toHaveLength(0);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'svd-test' });
    }
  });

  it('an upsert without a pattern preserves a previously-set pattern', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-prefs-upsert-'));
    try {
      const mgr = new PreferencesManager(dir);
      mgr.recordPreference({ learning: 'x', dedupeKey: 'k', violationPattern: 'regex:fresh session' });
      mgr.recordPreference({ learning: 'x refined', dedupeKey: 'k' }); // no pattern this time
      const store = mgr.read();
      expect(store.preferences).toHaveLength(1);
      expect(store.preferences[0].violationPattern).toBe('regex:fresh session');
      expect(store.preferences[0].dedupeCount).toBe(2);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'svd-test' });
    }
  });
});
