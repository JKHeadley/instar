import { describe, it, expect } from 'vitest';
import {
  stripComments,
  methodBodies,
  delegateTargets,
  classifyMethod,
} from '../helpers/atomicWriteScope.js';

/**
 * Method-scoped atomicity analysis — the primitives behind
 * `atomic-writes-consistency.test.ts`.
 *
 * THE DEFECT cases are the forms the previous file-scope/never-reset-flag check
 * could not see; each fails against that behaviour. The CONTROL cases pass under
 * BOTH, and they are the reason this is a check rather than an alarm: a rule
 * that flagged a correct funnel or a commented-out example would fail builds on
 * exemplary code, which costs more than the hole it closes.
 */

describe('THE DEFECT — writes the previous check could not see', () => {
  it('flags a bare write in a method whose body has no rename', () => {
    // The measured case: this exact shape, inserted into StateManager#saveSession,
    // passed all 21 of the old assertions.
    const src = [
      'class S {',
      '  saveSession(s: Session): void {',
      '    fs.writeFileSync(filePath, JSON.stringify(s), "utf-8");',
      '  }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'saveSession').verdict).toBe('non-atomic');
  });

  it('does not let a SIBLING method\'s rename vouch for this one', () => {
    // File-scope booleans made any renameSync anywhere satisfy any write anywhere.
    const src = [
      'class S {',
      '  saveSession(s) {',
      '    fs.writeFileSync(p, d);',
      '  }',
      '  unrelated() {',
      '    fs.renameSync(tmp, p);',
      '  }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'saveSession').verdict).toBe('non-atomic');
  });

  it('checks a method declared EARLY in the file, not only the last one', () => {
    // The never-reset flag meant only the window after the LAST method-name
    // mention reached the assertion.
    const src = [
      'class S {',
      '  saveSession(s) { fs.writeFileSync(p, d); }',
      '  later() { return 1; }',
      '  lastOfAll() { fs.writeFileSync(t, d); fs.renameSync(t, p); }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'saveSession').verdict).toBe('non-atomic');
  });

  it('flags a broken FUNNEL reached by delegation', () => {
    // A module that funnels its writes passes trivially under a per-method rule
    // (its own body contains no write at all). One level is resolved so the
    // funnel is what gets verified.
    const src = [
      'class S {',
      '  saveSession(s) { this.atomicWrite(p, d); }',
      '  private atomicWrite(p, d) { fs.writeFileSync(p, d); }',
      '}',
    ].join('\n');
    const r = classifyMethod(src, 'saveSession');
    expect(r.verdict).toBe('non-atomic');
    expect(r.via).toBe('atomicWrite');
  });

  it('does not accept a rename that exists only in a COMMENT', () => {
    const src = [
      'class S {',
      '  saveSession(s) {',
      '    // followed by fs.renameSync(tmp, p) — not really',
      '    fs.writeFileSync(p, d);',
      '  }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'saveSession').verdict).toBe('non-atomic');
  });

  it('reports a missing method rather than silently checking nothing', () => {
    // Two real declarations were stale when this landed: StateManager.saveState
    // and QuotaTracker.saveState have zero occurrences in their files.
    const r = classifyMethod('class S { other() {} }', 'saveState');
    expect(r.found).toBe(false);
    expect(r.verdict).toBeNull();
  });
});

describe('CONTROL — correct code stays passing (over-block is the dominant risk)', () => {
  it('accepts an in-body tmp-then-rename', () => {
    const src = [
      'class S {',
      '  updateState(s) {',
      '    fs.writeFileSync(tmpPath, JSON.stringify(s));',
      '    fs.renameSync(tmpPath, this.file);',
      '  }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'updateState').verdict).toBe('atomic-inline');
  });

  it('accepts delegation to a GENUINE atomic funnel', () => {
    // This is the real StateManager shape. Failing it would be a false red on
    // the single-funnel pattern this codebase argues for everywhere else.
    const src = [
      'class S {',
      '  saveSession(s) { this.atomicWrite(p, d); }',
      '  private atomicWrite(p, d) {',
      '    fs.writeFileSync(tmpPath, d);',
      '    fs.renameSync(tmpPath, p);',
      '  }',
      '}',
    ].join('\n');
    const r = classifyMethod(src, 'saveSession');
    expect(r.verdict).toBe('atomic-via-funnel');
    expect(r.via).toBe('atomicWrite');
  });

  it('does not invent a violation for a method that writes nothing', () => {
    const src = 'class S { appendEvent(e) { this.buffer.push(e); } }';
    expect(classifyMethod(src, 'appendEvent').verdict).toBe('no-write');
  });

  it('does not treat a commented-out write as a write', () => {
    const src = 'class S { save(s) { /* fs.writeFileSync(p, d); */ return; } }';
    expect(classifyMethod(src, 'save').verdict).toBe('no-write');
  });

  it('does not mistake a CALL site for a declaration', () => {
    // `this.saveSession({...})` inside another method is a call. Treating it as
    // a declaration is precisely how the old flag conflated two methods.
    const src = [
      'class S {',
      '  saveSession(s) { fs.writeFileSync(t, d); fs.renameSync(t, p); }',
      '  bulk(list) {',
      '    for (const s of list) this.saveSession({ ...s });',
      '    fs.writeFileSync(other, d);',
      '  }',
      '}',
    ].join('\n');
    expect(classifyMethod(src, 'saveSession').verdict).toBe('atomic-inline');
  });

  it('reports the WORST verdict across duplicate declarations, not the kindest', () => {
    const src = [
      'class A { save(s) { fs.writeFileSync(t, d); fs.renameSync(t, p); } }',
      'class B { save(s) { fs.writeFileSync(p, d); } }',
    ].join('\n');
    expect(classifyMethod(src, 'save').verdict).toBe('non-atomic');
  });
});

describe('the primitives, pinned directly', () => {
  it('strips comments without touching string contents, preserving line count', () => {
    const out = stripComments('const s = "// not a comment";\n// real\nconst t = 1;\n');
    expect(out).toContain('// not a comment');
    expect(out).not.toContain('real');
    expect(out.split('\n').length).toBe(4);
  });

  it('brace-matches a body containing a brace inside a string literal', () => {
    const src = 'class S { save() { const x = "}"; fs.writeFileSync(p, x); } }';
    const bodies = methodBodies(src, 'save');
    expect(bodies.length).toBe(1);
    expect(bodies[0].text).toContain('writeFileSync');
  });

  it('yields no body for an unbalanced brace — fails toward NOT reporting', () => {
    expect(methodBodies('class S { save() { fs.writeFileSync(p, d);', 'save').length).toBe(0);
  });

  it('reports the declaration line, not the call line', () => {
    const src = ['class S {', '  other() { this.save(1); }', '  save(n) { return n; }', '}'].join('\n');
    const bodies = methodBodies(src, 'save');
    expect(bodies.length).toBe(1);
    expect(bodies[0].line).toBe(3);
  });

  it('collects this.helper() delegation targets and ignores bare calls', () => {
    const targets = delegateTargets('{ this.atomicWrite(p, d); helper(1); obj.other(2); }');
    expect(targets).toContain('atomicWrite');
    expect(targets).not.toContain('helper');
    expect(targets).not.toContain('other');
  });

  it('does not resolve a method delegating to ITSELF as a funnel', () => {
    const src = 'class S { save(n) { if (n) this.save(n - 1); } }';
    expect(classifyMethod(src, 'save').verdict).toBe('no-write');
  });
});
