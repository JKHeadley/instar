/**
 * Ratchet: every PATCH/PUT route refuses a field it would not apply.
 *
 * A write that answers 200 while ignoring part of its body is a silent gate:
 * the caller believes a change landed that did not (2026-10-19, `PATCH
 * /attention/:id` with `{status, body}` stored the status and dropped the body).
 * Each handler must call `refuseUnsupportedFields` or carry its own allowlist
 * that refuses (listed below with the text that proves it). A new PATCH/PUT
 * route with neither fails this test.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILES = ['src/server/routes.ts', 'src/server/fileRoutes.ts'];

/** Routes with their own refusing allowlist, and a phrase from that refusal. */
const OWN_ALLOWLIST: Record<string, string> = {
  '/jobs/:slug': "Only { enabled: boolean } is accepted",
  '/config': 'Cannot patch these config keys via API',
  '/evolution/actions/:id': 'Unsupported field(s)',
  '/commitments/:id': 'Unknown field(s)',
  '/messages/spawn/config': 'Unknown fields',
};

function handlers(): Array<{ file: string; method: string; route: string; body: string }> {
  const out: Array<{ file: string; method: string; route: string; body: string }> = [];
  for (const file of FILES) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const re = /\n {2}router\.(patch|put)\('([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + 1;
      const next = text.indexOf('\n  router.', start + 10);
      out.push({ file, method: m[1], route: m[2], body: text.slice(start, next === -1 ? undefined : next) });
    }
  }
  return out;
}

describe('PATCH/PUT routes refuse unsupported fields', () => {
  const all = handlers();

  it('finds the write routes (the scan is not blind)', () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(all.map((h) => h.route)).toContain('/attention/:id');
  });

  for (const h of all) {
    it(`${h.method.toUpperCase()} ${h.route} (${h.file}) refuses fields it does not apply`, () => {
      const own = OWN_ALLOWLIST[h.route];
      if (own) {
        expect(h.body, `${h.route} is listed as carrying its own allowlist`).toContain(own);
        expect(h.body).not.toContain('refuseUnsupportedFields(');
      } else {
        expect(h.body, `${h.route} must call refuseUnsupportedFields or carry a refusing allowlist`).toContain('refuseUnsupportedFields(res, req.body');
      }
    });
  }

  it('every own-allowlist entry names a route that still exists', () => {
    const routes = new Set(all.map((h) => h.route));
    for (const route of Object.keys(OWN_ALLOWLIST)) expect(routes.has(route), route).toBe(true);
  });
});
