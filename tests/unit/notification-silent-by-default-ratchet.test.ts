/**
 * STD-SUBCOUNTDOWN-silent-by-default-emitters (CMT-1901): new notification emitters ship
 * silent-by-default and opt IN to notifying, never the reverse. This ratchet computes, from the
 * shipped code, every category that reaches a person by default (pushes, or is delivered rather than
 * held quiet) and every emitter that sends into one, and compares them with the reviewed baseline
 * docs/notification-default-posture-baseline.json. A new emitter mapped to a quiet category passes
 * untouched. A new loud default, or a new emitter into a loud category, fails until the baseline is
 * widened in the same change with a reason, which puts it in front of review. An entry that is no
 * longer true must be removed (the baseline only shrinks by itself).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PUSH_CATEGORIES } from '../../src/messaging/NotificationSelectivityGate.js';
import { PROTECTED_DELIVERY_CATEGORIES, SIGNIFICANT_TABLE, PRODUCER_NOTIFICATION_CATEGORIES, ATTENTION_FAMILY_CATEGORIES, notificationCategories } from '../../src/messaging/notificationCategories.js';
import { EMITTER_CATEGORIES, NAMED_EMITTERS } from '../../src/messaging/notificationStampers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Baseline = { loudCategories: Record<string, string>; loudEmitters: Record<string, string>; literalSites: Record<string, number>; _why: Record<string, string> };
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/notification-default-posture-baseline.json'), 'utf8')) as Baseline & { _readme?: unknown };

function loudCategories(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id] of notificationCategories) {
    const why = [
      DEFAULT_PUSH_CATEGORIES.has(id) ? 'default-push' : null,
      PROTECTED_DELIVERY_CATEGORIES.has(id) ? 'protected-delivery' : null,
      SIGNIFICANT_TABLE[id]?.length ? 'significant-classes' : null,
      id === 'update-announcement' ? 'release-audience-promotion' : null,
    ].filter(Boolean).join('+');
    if (why) out[id] = why;
  }
  return out;
}
function loudEmitters(loud: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [mod, cat] of Object.entries(EMITTER_CATEGORIES)) if (loud[cat]) out[mod] = cat;
  for (const [mod, named] of Object.entries(NAMED_EMITTERS)) for (const [p, cat] of Object.entries(named ?? {})) if (cat && loud[cat]) out[`${mod}#${p}`] = cat;
  for (const [p, cat] of Object.entries(PRODUCER_NOTIFICATION_CATEGORIES)) if (loud[cat]) out[`producer:${p}`] = cat;
  for (const [src, cat] of Object.entries(ATTENTION_FAMILY_CATEGORIES)) if (loud[cat]) out[`attention-family:${src}`] = cat;
  return out;
}

/**
 * Inline envelopes: modules the notification lint trusts may build an envelope themselves, outside
 * every registry. Count, per file under src/, each literal that makes a send loud: a loud category
 * id assigned to `category`, a `significantClass`, or `releaseAudiencePromoted: true`.
 */
function literalSites(loud: Record<string, string>): Record<string, number> {
  const ids = Object.keys(loud).map((id) => id.replace(/[-]/g, '\\-')).join('|');
  const pattern = new RegExp(`category\\s*:\\s*['"\`](?:${ids})['"\`]|significantClass\\s*:\\s*['"\`]|releaseAudiencePromoted\\s*:\\s*true`, 'g');
  const out: Record<string, number> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const f = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|js|mjs)$/.test(e.name)) {
        const n = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(pattern) ?? []).length;
        if (n) out[f] = n;
      }
    }
  };
  walk('src');
  return out;
}

describe('silent-by-default notification emitters (ratchet)', () => {
  it('every category that reaches a person by default is in the reviewed baseline, and nothing else', () => {
    expect(loudCategories()).toEqual(baseline.loudCategories);
  });

  it('every emitter that sends into a loud category is in the reviewed baseline, and nothing else', () => {
    expect(loudEmitters(loudCategories())).toEqual(baseline.loudEmitters);
  });

  it('every inline loud envelope literal is in the reviewed baseline, counted per file', () => {
    expect(literalSites(loudCategories())).toEqual(baseline.literalSites);
  });

  it('every baseline entry states why it may reach a person', () => {
    const keys = [...Object.keys(baseline.loudCategories), ...Object.keys(baseline.loudEmitters), ...Object.keys(baseline.literalSites)];
    expect(keys.filter((k) => !(typeof baseline._why[k] === 'string' && baseline._why[k].trim().length > 10))).toEqual([]);
    expect(Object.keys(baseline._why).filter((k) => !keys.includes(k))).toEqual([]); // no stale reasons
  });

  it('the catch-all category stays quiet, so an emitter added without thought is silent', () => {
    expect(loudCategories().uncategorized).toBeUndefined();
    expect(DEFAULT_PUSH_CATEGORIES.has('uncategorized')).toBe(false);
  });
});
