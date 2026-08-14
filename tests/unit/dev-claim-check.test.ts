/**
 * `instar dev:claim-check` — pre-build parallel-claim advisory.
 *
 * Earned from 2026-06-05: two pairs of parallel sessions built fixes for the
 * SAME incident twice in one night (#802 vs the keychain spec; #810 vs #808).
 * These tests pin the overlap semantics and the command's degrade behavior.
 * The `gh` boundary is injected — no network.
 */

import { describe, expect, it } from 'vitest';
import {
  findPrOverlaps,
  findSpecMatches,
  runDevClaimCheck,
  type ClaimCheckOutput,
  type ClaimPr,
} from '../../src/commands/devClaimCheck.js';

function capture(): { out: string[]; err: string[]; output: ClaimCheckOutput } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { write: (t) => out.push(t), error: (t) => err.push(t) } };
}

const PR_810: ClaimPr = {
  number: 810,
  title: 'fix(secrets): vault key coherence',
  headRefName: 'vault-key-coherence',
  updatedAt: '2026-06-05T08:00:00Z',
  files: [{ path: 'src/core/SecretStore.ts' }, { path: 'src/core/SecretSync.ts' }],
};

describe('findPrOverlaps', () => {
  it('THE COLLISION: exact-file overlap is detected (the #810-vs-#808 case)', () => {
    const hits = findPrOverlaps(['src/core/SecretStore.ts', 'src/core/Config.ts'], [PR_810], 'merged');
    expect(hits).toHaveLength(1);
    expect(hits[0].pr.number).toBe(810);
    expect(hits[0].overlap).toEqual(['src/core/SecretStore.ts']);
    expect(hits[0].bucket).toBe('merged');
  });

  it('directory claims collide with files under them, in BOTH directions', () => {
    // Claiming a directory catches a PR touching a file inside it…
    expect(findPrOverlaps(['src/core'], [PR_810], 'open')).toHaveLength(1);
    // …and claiming a file catches a PR that lists the directory.
    const dirPr: ClaimPr = { number: 1, title: 'dir claim', files: [{ path: 'src/core' }] };
    expect(findPrOverlaps(['src/core/SecretStore.ts'], [dirPr], 'open')).toHaveLength(1);
  });

  it('no false positives: disjoint paths and sibling-prefix names do not overlap', () => {
    // src/core must NOT match src/core2 (prefix needs the / boundary)
    const pr: ClaimPr = { number: 2, title: 'sibling', files: [{ path: 'src/core2/Other.ts' }] };
    expect(findPrOverlaps(['src/core'], [pr], 'open')).toHaveLength(0);
    expect(findPrOverlaps(['src/messaging/TelegramAdapter.ts'], [PR_810], 'open')).toHaveLength(0);
  });

  it('a PR with no files field is simply no overlap (not a crash)', () => {
    expect(findPrOverlaps(['src/core/Config.ts'], [{ number: 3, title: 'no files' }], 'open')).toHaveLength(0);
  });
});

describe('findSpecMatches', () => {
  const specs = [
    { file: 'keychain-per-agent-master-key.md', head: '# Secrets Boot Guard + Orphan-Proof Stores\nkeychain incident' },
    { file: 'vault-key-coherence.md', head: '# Vault key coherence — per-agent keychain slots' },
    { file: 'unrelated.md', head: '# Session pool transfer' },
  ];

  it('matches keywords case-insensitively against spec heads (the #802-vs-spec case)', () => {
    const hits = findSpecMatches(specs, ['Keychain']);
    expect(hits.map((h) => h.file)).toEqual([
      'keychain-per-agent-master-key.md',
      'vault-key-coherence.md',
    ]);
  });

  it('no keywords → no spec scan (empty result, not everything)', () => {
    expect(findSpecMatches(specs, [])).toHaveLength(0);
  });
});

describe('runDevClaimCheck', () => {
  it('reports open + merged overlaps and spec matches together, exit 0 (advisory)', async () => {
    const { out, output } = capture();
    const code = await runDevClaimCheck({
      paths: ['src/core/SecretStore.ts'],
      keywords: ['keychain'],
      output,
      deps: {
        ghJson: async (args) => (args.includes('open') ? [PR_810] : [{ ...PR_810, number: 811 }]),
        readSpecs: () => [{ file: 'vault-key-coherence.md', head: 'keychain slots' }],
      },
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('#810');
    expect(text).toContain('#811');
    expect(text).toContain('vault-key-coherence.md');
    expect(text).toContain('division-of-labor');
  });

  it('--strict exits 1 on overlap, 0 when clean', async () => {
    const cleanDeps = { ghJson: async () => [], readSpecs: () => [] };
    const hitDeps = { ghJson: async () => [PR_810], readSpecs: () => [] };
    expect(await runDevClaimCheck({ paths: ['src/core/SecretStore.ts'], strict: true, output: capture().output, deps: hitDeps })).toBe(1);
    expect(await runDevClaimCheck({ paths: ['src/core/SecretStore.ts'], strict: true, output: capture().output, deps: cleanDeps })).toBe(0);
  });

  it('gh failure degrades LOUDLY to spec-scan-only (advisory exit 0; strict exit 1)', async () => {
    const { err, output } = capture();
    const deps = {
      ghJson: async () => { throw new Error('gh: command not found'); },
      readSpecs: () => [],
    };
    const code = await runDevClaimCheck({ paths: ['src/core/Config.ts'], output, deps });
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('PR overlap NOT checked');
    // strict mode refuses to bless an unverified claim space
    const strictCode = await runDevClaimCheck({ paths: ['src/core/Config.ts'], strict: true, output: capture().output, deps });
    expect(strictCode).toBe(1);
  });

  it('no paths and no keywords → usage error (exit 2)', async () => {
    const { err, output } = capture();
    const code = await runDevClaimCheck({ paths: [], output, deps: { ghJson: async () => [] } });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('Nothing to check');
  });

  /**
   * ACT-1469 — gh SUCCEEDING with no usable output must not read as "nobody claims these paths".
   *
   * The old code did `JSON.parse(stdout || 'null')` and then `… as ClaimPr[] ?? []`, so empty
   * stdout on a ZERO EXIT became an empty PR list, nothing threw, `ghDegraded` stayed null, and the
   * tool printed a GREEN "✓ No claims found" having learned nothing. The error path was already
   * loud; its success-with-no-data sibling was wide open.
   *
   * Coverage note, stated rather than implied: these drive the CALLER guard through the injectable
   * `ghJson` seam, which is the layer that protects every implementation. The matching change inside
   * `defaultGhJson` (empty stdout → reject) is defence-in-depth on the real `gh` boundary and is
   * exercised only indirectly — it turns absence into the throw that the degrade test above pins.
   */
  it('THE DEFECT: gh returns nothing on success → degrades LOUDLY, never a green all-clear', async () => {
    const { out, err, output } = capture();
    // `null` is exactly what `JSON.parse(stdout || 'null')` produced from empty stdout.
    const deps = { ghJson: async () => null as unknown, readSpecs: () => [] };
    const code = await runDevClaimCheck({ paths: ['src/core/Config.ts'], output, deps });

    expect(err.join('\n')).toContain('PR overlap NOT checked');
    // The assertion that would have failed before the fix: no confident zero.
    expect(out.join('\n')).not.toContain('No claims found');
    expect(code).toBe(0); // advisory
    // strict refuses to bless a claim space it could not see
    expect(await runDevClaimCheck({ paths: ['src/core/Config.ts'], strict: true, output: capture().output, deps })).toBe(1);
  });

  it('CONTROL: a GENUINE zero (gh returns []) still prints the green all-clear', async () => {
    // Without this the fix could be a guard that always fires — indistinguishable from a correct
    // one on the defect case, and wrong on every real clean run.
    const { out, err, output } = capture();
    const code = await runDevClaimCheck({
      paths: ['src/core/Config.ts'],
      output,
      deps: { ghJson: async () => [], readSpecs: () => [] },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('No claims found');
    expect(err.join('\n')).not.toContain('PR overlap NOT checked');
  });

  it('a non-array shape (object/string) is absence of data, not zero results', async () => {
    for (const shape of [{ prs: [] } as unknown, 'null' as unknown, undefined as unknown]) {
      const { out, err, output } = capture();
      const code = await runDevClaimCheck({
        paths: ['src/core/Config.ts'],
        output,
        deps: { ghJson: async () => shape, readSpecs: () => [] },
      });
      expect(code).toBe(0);
      expect(err.join('\n')).toContain('PR overlap NOT checked');
      expect(out.join('\n')).not.toContain('No claims found');
    }
  });

  it('the MERGED call is guarded too, not just the open one', async () => {
    // Both call sites must be covered — guarding only the first would leave the second able to
    // coerce absence into zero, which is the same defect one line down.
    const { out, err, output } = capture();
    const code = await runDevClaimCheck({
      paths: ['src/core/Config.ts'],
      output,
      deps: {
        ghJson: async (args) => (args.includes('open') ? [] : (null as unknown)),
        readSpecs: () => [],
      },
    });
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('PR overlap NOT checked');
    expect(out.join('\n')).not.toContain('No claims found');
  });
});
