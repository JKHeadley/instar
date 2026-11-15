/**
 * docs/specs/mobile-pairing-outcome-notice.md §3.3–§3.4: the line text, the name filter, and the
 * system-template grammar that lets these lines skip the LLM tone gate.
 */
import { describe, it, expect } from 'vitest';
import { outcomeLine, outcomeSafeText, matchesPairingOutcomeLine, type PairingOutcome } from '../../src/core/PairingOutcomeText.js';
import { matchesSystemTemplate } from '../../src/messaging/system-templates.js';

const ALL: PairingOutcome[] = ['paired', 'declined-wrong-codes', 'declined', 'expired', 'interrupted', 'ended', 'not-delivered', 'unknown', 'link-void', 'link-expired'];

describe('outcomeSafeText', () => {
  it('keeps ordinary device names', () => {
    expect(outcomeSafeText("Justin's iPhone 15 Pro")).toBe("Justin's iPhone 15 Pro");
    expect(outcomeSafeText('Pixel-9  Pro')).toBe('Pixel-9 Pro');
    expect(outcomeSafeText('Téléphone de Zoë')).toBe('Téléphone de Zoë');
    expect(outcomeSafeText('Justin’s iPad')).toBe("Justin's iPad");
  });

  it('removes links, domains, mentions, formatting and invisible characters', () => {
    expect(outcomeSafeText('[Tap to re-approve](https://evil.example)')).toBe('Tap to re-approve https evil example');
    expect(outcomeSafeText('evil.com')).toBe('evil com');
    expect(outcomeSafeText('@admin')).toBe('admin');
    expect(outcomeSafeText('_x_ *bold*')).toBe('x bold');
    expect(outcomeSafeText('abc‮def​ghi')).toBe('abc def ghi');
  });

  it('cuts to 40 characters and returns null when nothing is left', () => {
    expect(outcomeSafeText('a'.repeat(200))!.length).toBe(40);
    expect(outcomeSafeText('...@@@///')).toBeNull();
    expect(outcomeSafeText(42)).toBeNull();
    expect(outcomeSafeText(null)).toBeNull();
  });
});

describe('outcomeLine', () => {
  const base = { agent: 'Echo', deviceName: "Justin's iPhone", label: 'Justin iPhone', fingerprint: 'ABCD-1234-EF56-7890' };

  it('writes the paired line in the past tense with the key', () => {
    expect(outcomeLine({ ...base, outcome: 'paired' })).toBe(`A phone named "Justin's iPhone" was paired with Echo (key ABCD-1234-EF56-7890).`);
  });

  it('falls back to the label, then to "A phone"', () => {
    expect(outcomeLine({ ...base, deviceName: null, outcome: 'declined' })).toBe('A phone named "Justin iPhone" was not paired with Echo: the request was declined or cancelled.');
    expect(outcomeLine({ agent: 'Echo', outcome: 'expired' })).toBe('A phone was not paired with Echo: nobody approved it in time. Ask for a new link to try again.');
  });

  it('drops a malformed fingerprint', () => {
    expect(outcomeLine({ ...base, fingerprint: 'not a key', outcome: 'paired' })).toBe(`A phone named "Justin's iPhone" was paired with Echo.`);
  });

  it('says "restarted" (not "moved") for a voided link and "without pairing" for an expired one', () => {
    expect(outcomeLine({ ...base, outcome: 'link-void' })).toBe('The pairing link for Echo ("Justin iPhone") stopped working when Echo restarted. Ask for a new link to try again.');
    expect(outcomeLine({ ...base, outcome: 'link-expired' })).toBe('The pairing link for Echo ("Justin iPhone") expired without pairing a phone.');
    expect(outcomeLine({ agent: 'Echo', outcome: 'link-expired' })).toBe('The pairing link for Echo expired without pairing a phone.');
  });

  it('every outcome, with and without names, matches the template grammar and the system template set', () => {
    for (const outcome of ALL) {
      for (const input of [{ ...base, outcome }, { agent: 'Echo', outcome }, { ...base, deviceName: '[x](https://e.vil) @a', outcome }]) {
        const line = outcomeLine(input);
        expect(matchesPairingOutcomeLine(line), line).toBe(true);
        expect(matchesSystemTemplate(line), line).toBe(true);
      }
    }
  });
});

describe('matchesPairingOutcomeLine', () => {
  it('refuses a line with any character outside the grammar', () => {
    expect(matchesPairingOutcomeLine('A phone named "evil.com" was paired with Echo.')).toBe(false);
    expect(matchesPairingOutcomeLine('A phone named "[x](https://e)" was paired with Echo.')).toBe(false);
    expect(matchesPairingOutcomeLine('A phone was paired with Echo. Click https://evil.example')).toBe(false);
    expect(matchesPairingOutcomeLine('Your account is locked, reply with your code.')).toBe(false);
    expect(matchesSystemTemplate('A phone named "x_y" was paired with Echo.')).toBe(false);
  });

  it('refuses over-long names', () => {
    expect(matchesPairingOutcomeLine(`A phone named "${'a'.repeat(41)}" was paired with Echo.`)).toBe(false);
  });
});
