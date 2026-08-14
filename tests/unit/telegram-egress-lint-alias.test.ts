/**
 * lint-telegram-egress-boundary — fetch alias resolution.
 *
 * The lint proves "exactly one file may call fetch on a Telegram Bot API URL".
 * Its own header named the gap plainly rather than hiding it:
 *
 *   "Still NOT covered […]: a fetch bound to a DIFFERENT name
 *    (`const send = fetch; send(url)`) […]. Catching those needs alias
 *    resolution this does not do."
 *
 * A peer-agent audit ranked this #2 of 25 checks defeatable by renaming, on the
 * grounds that this door carries the bot token. The gap is now closed on the
 * AST — the file is already parsed, and a variable declaration whose initialiser
 * IS the fetch function is unambiguous, where a regex over `= fetch` would also
 * match a property named fetch on an unrelated object.
 *
 * Driven directly rather than through the CLI's exit code: this lint has four
 * process.exit(1) paths, so an exit-code assertion cannot distinguish "caught
 * the violation" from "died on startup".
 */

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
// @ts-expect-error — plain .mjs lint script, no type declarations
import { collectFetchAliases } from '../../scripts/lint-telegram-egress-boundary.mjs';

const sf = (src: string): ts.SourceFile =>
  ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true);

const names = (src: string): string[] => [...collectFetchAliases(sf(src))];

describe('collectFetchAliases — the gap the header named', () => {
  it('THE GAP: `const send = fetch` binds an alias', () => {
    expect(names('const send = fetch;')).toContain('send');
  });

  it('a CHAIN of bindings resolves to a fixpoint', () => {
    expect(names('const a = fetch;\nconst b = a;\nconst c = b;')).toEqual(
      expect.arrayContaining(['a', 'b', 'c']),
    );
  });

  it('binds a property-access form too (`const f = globalThis.fetch`)', () => {
    expect(names('const f = globalThis.fetch;')).toContain('f');
  });

  // ── The other direction. A resolver that absorbed every declaration would
  //    pass every test above and flag correct code everywhere — and this lint
  //    blocks commits, so over-matching is the more expensive failure.
  it('CONTROL: an unrelated initialiser is NOT bound', () => {
    expect(names('const send = somethingElse;')).not.toContain('send');
  });

  it('CONTROL: a property that merely ends in a different name is NOT bound', () => {
    expect(names('const f = obj.notFetch;')).not.toContain('f');
  });

  it('CONTROL: a file with no fetch reference yields an empty set', () => {
    expect(names('const a = 1;\nconst b = a;')).toEqual([]);
  });

  it('CONTROL: a string literal "fetch" is not a binding', () => {
    expect(names("const send = 'fetch';")).not.toContain('send');
  });

  // Scope, pinned so the boundary is documented rather than assumed. These are
  // named in the lint header as still-open; if someone closes them properly,
  // these tests fail and get updated deliberately.
  it('KNOWN GAP: a re-assignment after declaration is NOT followed', () => {
    expect(names('let send;\nsend = fetch;')).not.toContain('send');
  });

  it('KNOWN GAP: a fetch arriving as a PARAMETER is NOT followed', () => {
    expect(names('function go(send) { send(url); }')).not.toContain('send');
  });
});
