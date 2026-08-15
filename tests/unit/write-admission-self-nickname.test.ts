import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `WriteAdmission` renders its status as
 *   `thisMachine: { machineId, nickname: this.d.selfNickname?.() ?? null }`
 * so a refusal can say WHICH machine owns the state it refused to let this one
 * write. The dep was declared (`WriteAdmission.ts`) and consumed, and supplied
 * NOWHERE — so every machine reported `nickname: null` and could not name itself.
 *
 * THE TEST'S OWN DESIGN COMES FROM A MISTAKE I MADE FINDING THIS. My first search
 * for the construction site was `grep 'new WriteAdmission'` and returned ZERO — I
 * was one step from concluding the component is never instantiated and the finding
 * is moot. It is constructed as `new waMod.WriteAdmission({...})`, through a
 * dynamic-import namespace. A bare-identifier scan that misses the
 * namespace-qualified form is the exact defect class three lints were fixed for
 * tonight, committed by me while auditing for it.
 *
 * So this guard matches `new <optional.namespace.>WriteAdmission(` and pins that
 * behaviour with a control, rather than trusting the spelling that happens to be
 * in the tree today.
 */

const ROOT = path.resolve(__dirname, '..', '..');

/** Every `new [ns.]WriteAdmission(` construction, with its brace-matched options object. */
export function findWriteAdmissionConstructions(source: string): Array<{ line: number; opts: string }> {
  const out: Array<{ line: number; opts: string }> = [];
  // The optional `<ident>.` prefix is the whole point — see the docblock.
  const re = /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*WriteAdmission\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      const c = source[i];
      if (quote) {
        if (c === '\\') { i += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue; // unbalanced — fail toward NOT reporting
    out.push({ line: source.slice(0, m.index).split('\n').length, opts: source.slice(open, end + 1) });
  }
  return out;
}

describe('WriteAdmission wiring — selfNickname is supplied at every construction site', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf-8');
  const sites = findWriteAdmissionConstructions(serverSrc);

  it('finds at least one construction site', () => {
    // CONTROL. Without this, a scan that matched NOTHING would pass the
    // per-site assertion below vacuously — "every site supplies it" is trivially
    // true of zero sites. That is the shape this whole night has been about.
    expect(sites.length).toBeGreaterThan(0);
  });

  for (const site of sites) {
    it(`supplies selfNickname at server.ts:${site.line}`, () => {
      expect(
        /\bselfNickname\s*:/.test(site.opts),
        `WriteAdmission constructed at server.ts:${site.line} without selfNickname — its status ` +
          `will report thisMachine.nickname: null, so the machine cannot name itself in a refusal`
      ).toBe(true);
    });

    it(`supplies nicknameOf at server.ts:${site.line}`, () => {
      // The other half of the same gap, and the more useful one. `refusal()`
      // builds  `This write belongs to ${ownerNick ? `'${ownerNick}'` : `machine ${ownerId}`}`
      // so with nicknameOf unsupplied, ownerNick was ALWAYS null and every
      // refusal fell to the raw-hex branch — the readable branch unreachable.
      // Naming the owning machine is the entire point of a refusal that tells
      // you where to re-send.
      expect(
        /\bnicknameOf\s*:/.test(site.opts),
        `WriteAdmission constructed at server.ts:${site.line} without nicknameOf — every refusal ` +
          `will name the owner by raw machine id instead of nickname`
      ).toBe(true);
    });

    it(`still supplies thisMachineId at server.ts:${site.line}`, () => {
      // A second required dep, asserted so a future edit that guts the options
      // object fails loudly here rather than only at the nickname.
      expect(/\bthisMachineId\s*:/.test(site.opts)).toBe(true);
    });
  }
});

describe('the scanner itself, pinned', () => {
  it('matches the NAMESPACE-QUALIFIED form — the one my own grep missed', () => {
    const found = findWriteAdmissionConstructions(
      'const x = new waMod.WriteAdmission({ thisMachineId: a, selfNickname: () => null });'
    );
    expect(found.length).toBe(1);
    expect(found[0].opts).toContain('selfNickname');
  });

  it('matches the bare form too', () => {
    expect(findWriteAdmissionConstructions('new WriteAdmission({ a: 1 });').length).toBe(1);
  });

  it('matches a deeply-qualified form', () => {
    expect(findWriteAdmissionConstructions('new a.b.WriteAdmission({ c: 1 });').length).toBe(1);
  });

  it('does not match a different class whose name merely ends the same way', () => {
    // Over-block control: `NotWriteAdmission` is a different symbol.
    expect(findWriteAdmissionConstructions('new NotWriteAdmission({ a: 1 });').length).toBe(0);
  });

  it('does not match a mere type reference or import', () => {
    expect(findWriteAdmissionConstructions('import { WriteAdmission } from "./x.js";').length).toBe(0);
    expect(findWriteAdmissionConstructions('let a: WriteAdmission | null = null;').length).toBe(0);
  });

  it('brace-matches an options object containing a brace inside a string', () => {
    const found = findWriteAdmissionConstructions('new WriteAdmission({ a: "}", selfNickname: () => null });');
    expect(found.length).toBe(1);
    expect(found[0].opts).toContain('selfNickname');
  });

  it('yields nothing for an unbalanced options object — fails toward NOT reporting', () => {
    expect(findWriteAdmissionConstructions('new WriteAdmission({ a: 1').length).toBe(0);
  });
});
