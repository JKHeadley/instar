import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { registryAssetIsStale, REGISTRY_ASSET_INPUTS } from '../setup/registryAssetFreshness.js';

/**
 * Two globalSetup files decided whether to regenerate the packed constitution by
 * asking only whether its outputs EXIST. An asset generated from an older source
 * therefore survived forever, because existing was the whole test.
 *
 * Measured on 2026-08-15: in a checkout whose asset was generated three hours
 * before its source, three test files failed with eight assertions; regenerating
 * the asset made all 77 pass. The presence check could see an ABSENT asset and was
 * structurally unable to see a WRONG one.
 */

const OP = 'tests/unit/registry-asset-freshness.test.ts';

/** A throwaway root with real inputs and outputs, and control over their mtimes. */
function makeRoot(opts: { outputsOlderThanInputs: boolean; omitOutput?: boolean; omitInputs?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-freshness-'));
  const outDir = path.join(root, 'src', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });

  const outputs = ['standards-registry.md', 'standards-registry.meta.json'].map(f => path.join(outDir, f));

  const OLD = new Date('2026-01-01T00:00:00Z');
  const NEW = new Date('2026-06-01T00:00:00Z');

  // Outputs first, then inputs, so the ORDER of writes never decides the answer —
  // only the mtimes we set explicitly do.
  for (const o of outputs) fs.writeFileSync(o, 'generated\n');
  // Through the audited funnel, not a raw removal — the destructive-op rule applies
  // to fixtures too, and I have tripped that lint three times this week by
  // forgetting it in exactly this position.
  if (opts.omitOutput) SafeFsExecutor.safeRmSync(outputs[1], { force: true, operation: OP });

  if (!opts.omitInputs) {
    for (const rel of REGISTRY_ASSET_INPUTS) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'source\n');
      fs.utimesSync(p, opts.outputsOlderThanInputs ? NEW : OLD, opts.outputsOlderThanInputs ? NEW : OLD);
    }
  }
  for (const o of outputs) {
    if (fs.existsSync(o)) fs.utimesSync(o, opts.outputsOlderThanInputs ? OLD : NEW, opts.outputsOlderThanInputs ? OLD : NEW);
  }
  return { root, outputs };
}

function withRoot(opts: Parameters<typeof makeRoot>[0], fn: (r: { root: string; outputs: string[] }) => void) {
  const r = makeRoot(opts);
  try { fn(r); } finally {
    SafeFsExecutor.safeRmSync(r.root, { recursive: true, force: true, operation: OP });
  }
}

describe('THE DEFECT — an asset that exists but is older than its source', () => {
  it('is reported STALE', () => {
    withRoot({ outputsOlderThanInputs: true }, ({ root, outputs }) => {
      // Every output exists, so the presence check this replaces returned "fine".
      expect(outputs.every(o => fs.existsSync(o))).toBe(true);
      expect(registryAssetIsStale(root, outputs)).toBe(true);
    });
  });
});

describe('CONTROLS — the cases that must NOT regenerate (this runs on every suite start)', () => {
  it('an asset NEWER than every input is not stale', () => {
    withRoot({ outputsOlderThanInputs: false }, ({ root, outputs }) => {
      expect(registryAssetIsStale(root, outputs)).toBe(false);
    });
  });

  it('equal mtimes are not stale — otherwise a same-second write regenerates on every run', () => {
    withRoot({ outputsOlderThanInputs: false }, ({ root, outputs }) => {
      const when = new Date('2026-03-03T03:03:03Z');
      for (const rel of REGISTRY_ASSET_INPUTS) fs.utimesSync(path.join(root, rel), when, when);
      for (const o of outputs) fs.utimesSync(o, when, when);
      expect(registryAssetIsStale(root, outputs)).toBe(false);
    });
  });

  it('no readable input means NOT stale — a missing source must not trigger a doomed regeneration', () => {
    withRoot({ outputsOlderThanInputs: false, omitInputs: true }, ({ root, outputs }) => {
      expect(registryAssetIsStale(root, outputs)).toBe(false);
    });
  });

  it('an empty output list is not stale', () => {
    withRoot({ outputsOlderThanInputs: true }, ({ root }) => {
      expect(registryAssetIsStale(root, [])).toBe(false);
    });
  });
});

describe('the pre-existing behaviour is preserved, not replaced', () => {
  it('an ABSENT output is still stale', () => {
    withRoot({ outputsOlderThanInputs: false, omitOutput: true }, ({ root, outputs }) => {
      expect(registryAssetIsStale(root, outputs)).toBe(true);
    });
  });
});

describe('wiring — every setup that regenerates the asset asks about freshness', () => {
  const SETUP_DIR = path.resolve(__dirname, '..', 'setup');

  /**
   * Matched on the MODULE SPECIFIER, not the imported name. A wiring guard keyed
   * on an identifier is defeated by `import { registryAssetIsStale as fresh }` —
   * the alias blindness that shipped in an invariant test earlier this same week
   * and was found by a peer, not by me.
   */
  const setupsThatGenerate = fs.readdirSync(SETUP_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => ({ file: f, src: fs.readFileSync(path.join(SETUP_DIR, f), 'utf-8') }))
    .filter(({ src }) => /standards-registry\.md/.test(src) && /standards-guard-index\.json/.test(src));

  it('finds the setups that generate the asset', () => {
    // Anti-vacuity control: with zero files found, every per-file assertion below
    // is trivially true. Both known generators must be in the set.
    expect(setupsThatGenerate.map(s => s.file).sort()).toEqual(
      ['build-dist.globalSetup.ts', 'ensure-registry-asset.globalSetup.ts'],
    );
  });

  for (const { file } of setupsThatGenerate) {
    it(`${file} imports the freshness rule rather than carrying its own`, () => {
      const src = fs.readFileSync(path.join(SETUP_DIR, file), 'utf-8');
      expect(
        /from\s+'\.\/registryAssetFreshness\.js'/.test(src),
        `${file} decides regeneration without the shared freshness rule — a presence-only `
          + 'check cannot see an asset that exists and is wrong',
      ).toBe(true);
    });
  }
});
