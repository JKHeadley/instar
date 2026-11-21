/**
 * Identity A4: a phone let in at the agent's own computer has no approval power until piece 3b.
 * Two record fields carry that fact: `admission: 'at-computer'` (set at redeem, while pending) and
 * `approvedVia: 'at-computer'` (set at activation). This pins them together:
 *  1. `admittedAtComputer` is the one answer, true when EITHER field says so;
 *  2. the store refuses an activation that would make the two disagree;
 *  3. no source file compares either field to 'at-computer' directly for a decision (a ratchet),
 *     so a later path that sets one field without the other cannot slip past a check keyed on the other.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry, admittedAtComputer, type ApprovedVia } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/at-computer-invariant.test.ts' }); });
function registry(): DeviceRegistry {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'atc-'));
  dirs.push(d);
  return new DeviceRegistry(d, () => Date.parse('2026-11-20T10:00:00Z'));
}
const key = (): string => crypto.randomBytes(65).toString('base64url');

describe('the two at-computer fields stay one fact', () => {
  it('admittedAtComputer is true when either field says at-computer, for every combination', () => {
    const vias: Array<ApprovedVia | undefined> = [undefined, 'telegram-dm', 'dashboard-pin', 'owner-phone', 'owner-agent', 'person-phone', 'local-install', 'at-computer'];
    for (const admission of [undefined, 'at-computer'] as const) {
      for (const approvedVia of vias) {
        const expected = admission === 'at-computer' || approvedVia === 'at-computer';
        expect(admittedAtComputer({ admission, approvedVia }), `${admission}/${approvedVia}`).toBe(expected);
      }
    }
    expect(admittedAtComputer(null)).toBe(false);
    expect(admittedAtComputer(undefined)).toBe(false);
  });

  it('a phone admitted at the computer is activated only as at-computer', () => {
    const reg = registry();
    for (const via of ['telegram-dm', 'dashboard-pin', 'owner-phone', 'owner-agent', 'person-phone', 'local-install', undefined] as const) {
      const c = reg.createPending({ deviceName: 'p', label: null, publicKey: key(), host: 'h', admission: 'at-computer' });
      if (!c.ok) throw new Error('setup');
      const after = reg.applyConfirm(c.device.id, { ok: true, ...(via ? { approvedVia: via } : {}) });
      expect(after?.status, String(via)).toBe('pending');
      expect(reg.get(c.device.id)?.approvedVia).toBeUndefined();
      reg.decline(c.device.id);
    }
    const c = reg.createPending({ deviceName: 'p', label: null, publicKey: key(), host: 'h', admission: 'at-computer' });
    if (!c.ok) throw new Error('setup');
    const after = reg.applyConfirm(c.device.id, { ok: true, approvedVia: 'at-computer' });
    expect(after?.status).toBe('active');
    expect(after?.admission).toBe('at-computer');
    expect(after?.approvedVia).toBe('at-computer');
  });

  it('at-computer activates only a phone admitted that way', () => {
    const reg = registry();
    const c = reg.createPending({ deviceName: 'p', label: null, publicKey: key(), host: 'h' });
    if (!c.ok) throw new Error('setup');
    expect(reg.applyConfirm(c.device.id, { ok: true, approvedVia: 'at-computer' })?.status).toBe('pending');
    // The ordinary path is unchanged.
    expect(reg.applyConfirm(c.device.id, { ok: true, approvedVia: 'dashboard-pin' })?.status).toBe('active');
  });

  it('every active record in a store agrees on both fields', () => {
    const reg = registry();
    const a = reg.createPending({ deviceName: 'a', label: null, publicKey: key(), host: 'h', admission: 'at-computer' });
    const b = reg.createPending({ deviceName: 'b', label: null, publicKey: key(), host: 'h' });
    if (!a.ok || !b.ok) throw new Error('setup');
    // Every way applyConfirm can be asked, on both records.
    for (const id of [a.device.id, b.device.id]) {
      for (const via of ['telegram-dm', 'at-computer', 'dashboard-pin'] as const) reg.applyConfirm(id, { ok: true, approvedVia: via });
    }
    for (const d of reg.list().filter((x) => x.status === 'active')) {
      expect(d.admission === 'at-computer', d.deviceName ?? '').toBe(d.approvedVia === 'at-computer');
    }
    expect(reg.list().filter((x) => x.status === 'active')).toHaveLength(2);
  });

  it('no source file decides on either field directly (ratchet, with a positive control)', () => {
    const root = path.resolve(__dirname, '../../src');
    const q = `['"\`]at-computer['"\`]`;
    const direct = new RegExp(`\\b(?:admission|approvedVia)\\s*(?:===|!==|==|!=)\\s*${q}|${q}\\s*(?:===|!==|==|!=)\\s*[\\w?.]*\\b(?:admission|approvedVia)\\b`);
    // Positive control: the pattern catches the shapes the old checks had.
    expect(direct.test("if (d.admission === 'at-computer') return 'code-only';")).toBe(true);
    expect(direct.test("if (peek?.approvedVia === 'at-computer' && !rule.browser")).toBe(true);
    expect(direct.test("d.admission !== 'at-computer' &&")).toBe(true);
    expect(direct.test('if (d.approvedVia === "at-computer")')).toBe(true);
    expect(direct.test('if (d.approvedVia === `at-computer`)')).toBe(true);
    // Allowed: the helper itself and the store's agreement check (two lines of MobileDeviceKeys.ts), and a
    // line marked `at-computer-ratchet-ok` with its reason. Anything else uses admittedAtComputer.
    const allowedLines = (rel: string, line: string): boolean =>
      line.includes('at-computer-ratchet-ok')
      || (rel === 'core/MobileDeviceKeys.ts' && (line.includes("return !!d && (d.admission === 'at-computer' || d.approvedVia === 'at-computer');")
        || line.includes("(d.admission === 'at-computer') !== (outcome.approvedVia === 'at-computer')")));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(e.name)) {
          const rel = path.relative(root, p).split(path.sep).join('/');
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (direct.test(line) && !allowedLines(rel, line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`); });
        }
      }
    };
    walk(root);
    expect(hits, 'use admittedAtComputer(d) instead of comparing one field').toEqual([]);
  });
});
