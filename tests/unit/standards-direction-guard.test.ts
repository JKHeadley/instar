// safe-git-allow: isolated tmpdir mutations are the guard's P3 negative controls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonicalDirectionPayload,
  evaluateStandardsDirection,
  inventoryStandardsArticles,
  resolveProtectedApproverKey,
  resolveProtectedBaseRegistry,
} from '../../scripts/standards-direction-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(__dirname, '../../scripts/standards-direction-guard.mjs');
const CORE = path.resolve(__dirname, '../../scripts/standards-registry-article-core.mjs');
const CONTRACT = path.resolve(__dirname, 'standards-direction-guard-contract.test.ts');
const VITEST = path.resolve(__dirname, '../../node_modules/vitest/vitest.mjs');
const BASE_REVISION = 'protected-base-fixture';

const baseRegistry = [
  '# Standards',
  '',
  '## The Root',
  '',
  '### Structure beats Willpower',
  '**Article ID.** `structure-beats-willpower`',
  '**Rule.** If behavior matters, enforce it in architecture and never rely on remembering.',
  '**Applied through.** `scripts/standards-direction-guard.mjs`.',
  '',
  '## Building',
  '',
  '### Honest Gap',
  '**Article ID.** `honest-gap`',
  '**Rule.** Preserve this obligation.',
  '**In practice.** Use judgment.',
  '',
].join('\n');

function replaceRootRule(markdown: string, rule: string): string {
  return markdown.replace(
    '**Rule.** If behavior matters, enforce it in architecture and never rely on remembering.',
    `**Rule.** ${rule}`,
  );
}

function removeGap(markdown: string): string {
  return markdown.replace([
    '### Honest Gap',
    '**Article ID.** `honest-gap`',
    '**Rule.** Preserve this obligation.',
    '**In practice.** Use judgment.',
    '',
  ].join('\n'), '');
}

function summary(article: ReturnType<typeof inventoryStandardsArticles>['articles'][number] | undefined) {
  if (!article) return null;
  return {
    id: article.id,
    family: article.family,
    name: article.name,
    ruleSha256: article.ruleSha256,
    articleSha256: article.articleSha256,
  };
}

function approvalFor(input: {
  base: string;
  candidate: string;
  articleId: string;
  direction: 'add' | 'remove' | 'strengthen' | 'neutral' | 'weaken';
  privateKey: crypto.KeyObject;
  approvedBy?: string;
}) {
  const probe = evaluateStandardsDirection({
    baseMarkdown: input.base,
    candidateMarkdown: input.candidate,
    baseRevision: BASE_REVISION,
  });
  const before = inventoryStandardsArticles(input.base).articles.find((article) => article.id === input.articleId);
  const after = inventoryStandardsArticles(input.candidate).articles.find((article) => article.id === input.articleId);
  const change = before && after ? 'edit' : before ? 'remove' : 'add';
  const payload = {
    schemaVersion: 1,
    baseRevision: BASE_REVISION,
    baseRegistrySha256: probe.baseRegistrySha256,
    candidateRegistrySha256: probe.candidateRegistrySha256,
    articleId: input.articleId,
    change,
    direction: input.direction,
    before: summary(before),
    after: summary(after),
    approvedBy: input.approvedBy ?? 'fixture-independent-operator',
    approvedAt: '2026-08-17T16:00:00.000Z',
  };
  return {
    payload,
    signature: crypto.sign(
      null,
      Buffer.from(canonicalDirectionPayload(payload), 'utf8'),
      input.privateKey,
    ).toString('base64'),
  };
}

describe('standards direction guard', () => {
  let keyPair: ReturnType<typeof crypto.generateKeyPairSync>;

  beforeEach(() => {
    keyPair = crypto.generateKeyPairSync('ed25519');
  });

  it('C1 passes the pristine registry and exposes a non-vacuous denominator', () => {
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: baseRegistry,
      baseRevision: BASE_REVISION,
    });
    expect(result.status).toBe('passed');
    expect(result.errors).toEqual([]);
    expect(result.population).toEqual(expect.objectContaining({ protectedBase: 2, candidate: 2, continuity: 2 }));
  });

  it('P1/P4b names a real article REMOVAL and keeps the protected-base denominator', () => {
    const candidate = removeGap(baseRegistry);
    expect(candidate).not.toContain('### Honest Gap'); // C2 mutation-applied control
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: BASE_REVISION,
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('REMOVAL "Honest Gap"');
    expect(result.population).toEqual(expect.objectContaining({ protectedBase: 2, candidate: 1, continuity: 2 }));
    expect(result.population.removals).toEqual(['honest-gap']);
  });

  it('P2 refuses a self-authored removal attestation signed by the wrong principal', () => {
    const candidate = removeGap(baseRegistry);
    const attacker = crypto.generateKeyPairSync('ed25519');
    const approval = approvalFor({
      base: baseRegistry,
      candidate,
      articleId: 'honest-gap',
      direction: 'remove',
      privateKey: attacker.privateKey,
      approvedBy: 'fixture-changer',
    });
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: BASE_REVISION,
      approvalLedger: { schemaVersion: 1, approvals: [approval] },
      approverPublicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('REMOVAL "Honest Gap" lacks a valid different-principal signature');
  });

  it('names a declared WEAKENING and refuses the changer\'s signature', () => {
    const candidate = replaceRootRule(
      baseRegistry,
      'We should prefer architecture where practical; remembering is an acceptable alternative.',
    );
    expect(candidate).toContain('remembering is an acceptable alternative'); // C2
    const attacker = crypto.generateKeyPairSync('ed25519');
    const approval = approvalFor({
      base: baseRegistry,
      candidate,
      articleId: 'structure-beats-willpower',
      direction: 'weaken',
      privateKey: attacker.privateKey,
      approvedBy: 'fixture-changer',
    });
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: BASE_REVISION,
      approvalLedger: { schemaVersion: 1, approvals: [approval] },
      approverPublicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain(
      'WEAKENING "Structure beats Willpower" lacks a valid different-principal signature',
    );
  });

  it('refuses a candidate-tree pin replacement signed by the changer', () => {
    const candidate = replaceRootRule(
      baseRegistry,
      'We should prefer architecture where practical; remembering is an acceptable alternative.',
    );
    const attacker = crypto.generateKeyPairSync('ed25519');
    const protectedKeyFile = path.join(os.tmpdir(), `s5-protected-key-${crypto.randomUUID()}.pem`);
    const candidateKeyFile = path.join(os.tmpdir(), `s5-candidate-key-${crypto.randomUUID()}.pem`);
    fs.writeFileSync(
      protectedKeyFile,
      keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    fs.writeFileSync(
      candidateKeyFile,
      attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    try {
      const protectedPin = resolveProtectedApproverKey({
        root: os.tmpdir(),
        explicitFile: protectedKeyFile,
        explicitRevision: BASE_REVISION,
      });
      expect(protectedPin.pem).not.toBe(fs.readFileSync(candidateKeyFile, 'utf8')); // attack applied
      const approval = approvalFor({
        base: baseRegistry,
        candidate,
        articleId: 'structure-beats-willpower',
        direction: 'weaken',
        privateKey: attacker.privateKey,
        approvedBy: 'fixture-changer-after-pin-swap',
      });
      const result = evaluateStandardsDirection({
        baseMarkdown: baseRegistry,
        candidateMarkdown: candidate,
        baseRevision: BASE_REVISION,
        approvalLedger: { schemaVersion: 1, approvals: [approval] },
        approverPublicKeyPem: protectedPin.pem,
        candidateApproverPublicKeyPem: fs.readFileSync(candidateKeyFile, 'utf8'),
      });
      expect(result.status).toBe('not-proven');
      expect(result.errors.join('\n')).toContain('APPROVER TRUST ROOT CHANGE is not self-authorizable');
      expect(result.errors.join('\n')).toContain(
        'WEAKENING "Structure beats Willpower" lacks a valid different-principal signature',
      );
    } finally {
      fs.rmSync(protectedKeyFile, { force: true });
      fs.rmSync(candidateKeyFile, { force: true });
    }
  });

  it('refuses a pin-only goalpost move before it can become the next protected base', () => {
    const protectedPin = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const attacker = crypto.generateKeyPairSync('ed25519');
    const attackerPin = attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(attackerPin).not.toBe(protectedPin); // C2 mutation-applied control

    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: baseRegistry,
      baseRevision: BASE_REVISION,
      approvalLedger: { schemaVersion: 1, approvals: [] },
      approverPublicKeyPem: protectedPin,
      candidateApproverPublicKeyPem: attackerPin,
    });

    expect(result.status).toBe('not-proven');
    expect(result.changes).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining('APPROVER TRUST ROOT CHANGE is not self-authorizable'),
    ]);
  });

  it('allows a legitimate strengthening independently ratified over the exact bytes', () => {
    const candidate = replaceRootRule(
      baseRegistry,
      'If behavior matters, enforce it in architecture, exercise the guard, and preserve the negative control.',
    );
    const approval = approvalFor({
      base: baseRegistry,
      candidate,
      articleId: 'structure-beats-willpower',
      direction: 'strengthen',
      privateKey: keyPair.privateKey,
    });
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: BASE_REVISION,
      approvalLedger: { schemaVersion: 1, approvals: [approval] },
      approverPublicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(result.status).toBe('passed');
    expect(result.errors).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({ articleId: 'structure-beats-willpower', direction: 'strengthen' }),
    ]);
  });

  it('rejects a signature replay after any candidate byte changes', () => {
    const candidate = replaceRootRule(baseRegistry, 'If behavior matters, enforce it twice.');
    const approval = approvalFor({
      base: baseRegistry,
      candidate,
      articleId: 'structure-beats-willpower',
      direction: 'strengthen',
      privateKey: keyPair.privateKey,
    });
    const changedAgain = `${candidate}\n<!-- one more byte -->\n`;
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: changedAgain,
      baseRevision: BASE_REVISION,
      approvalLedger: { schemaVersion: 1, approvals: [approval] },
      approverPublicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('DIRECTION UNDECLARED "Structure beats Willpower"');
  });

  it('P4a rejects an empty population instead of scoring 0/0 clean', () => {
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: '# Standards\n',
      baseRevision: BASE_REVISION,
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('candidate: standards article population is empty');
  });

  it('P4b rejects a Rule field planted outside the structural article enumeration', () => {
    const candidate = `${baseRegistry}\n**Rule.** Hidden outside every article heading.\n`;
    const result = evaluateStandardsDirection({
      baseMarkdown: baseRegistry,
      candidateMarkdown: candidate,
      baseRevision: BASE_REVISION,
    });
    expect(result.status).toBe('not-proven');
    expect(result.errors.join('\n')).toContain('candidate: article enumeration is open');
  });

  it('P5 reports NOT-PROVEN when the protected base is absent', () => {
    const missing = path.join(os.tmpdir(), `s5-missing-${crypto.randomUUID()}.md`);
    const result = resolveProtectedBaseRegistry({ root: os.tmpdir(), explicitFile: missing });
    expect(result.markdown).toBeNull();
    expect(result.errors.join('\n')).toContain('protected-base registry is unavailable');
  });
});

describe('standards direction guard P3 negative controls', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standards-direction-p3-'));
    fs.copyFileSync(CORE, path.join(tmp, 'standards-registry-article-core.mjs'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function contractRun() {
    const run = spawnSync(process.execPath, [VITEST, 'run', CONTRACT], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        NO_COLOR: '1',
        STANDARDS_DIRECTION_GUARD_UNDER_TEST: path.join(tmp, 'standards-direction-guard.mjs'),
      },
      encoding: 'utf8',
    });
    return {
      exitCode: run.status ?? 1,
      output: `${run.stdout}${run.stderr}`,
    };
  }

  function reportP3(label: string, run: ReturnType<typeof contractRun>) {
    if (process.env.S5_REPORT_P3 !== '1') return;
    const deciding = run.output.split('\n').filter((line) =>
      /Failed to load|Cannot find|is not a function|AssertionError|expected |Test Files|Tests\s+\d+/.test(line),
    );
    process.stderr.write(`\n[S5-P3 ${label}] exit=${run.exitCode}\n${deciding.slice(-18).join('\n')}\n`);
  }

  it('3a DELETE makes the exact-symbol contract fail', () => {
    expect(fs.existsSync(path.join(tmp, 'standards-direction-guard.mjs'))).toBe(false); // mutation applied
    const run = contractRun();
    reportP3('3a-delete', run);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/Failed to load|Cannot find module|does not exist/);
  });

  it('3b COMMENT OUT makes the exact-symbol contract fail', () => {
    const source = fs.readFileSync(GUARD, 'utf8');
    const sabotaged = source.split('\n').map((line) => `// ${line}`).join('\n');
    fs.writeFileSync(path.join(tmp, 'standards-direction-guard.mjs'), sabotaged);
    const commented = fs.readFileSync(path.join(tmp, 'standards-direction-guard.mjs'), 'utf8');
    expect(commented.split('\n').filter(Boolean).every((line) => line.startsWith('// '))).toBe(true); // mutation applied
    const run = contractRun();
    reportP3('3b-comment-out', run);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain('guard.evaluateStandardsDirection is not a function');
  });

  it('3c SUPERSTRING RENAME makes the exact-symbol contract fail', () => {
    const source = fs.readFileSync(GUARD, 'utf8');
    const sabotaged = source.replaceAll('evaluateStandardsDirection', 'evaluateStandardsDirectionDisabled');
    fs.writeFileSync(path.join(tmp, 'standards-direction-guard.mjs'), sabotaged);
    expect(sabotaged).toContain('evaluateStandardsDirectionDisabled'); // mutation applied
    expect(sabotaged).not.toMatch(/\bevaluateStandardsDirection\b/);
    const run = contractRun();
    reportP3('3c-superstring-rename', run);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain('guard.evaluateStandardsDirection is not a function');
  });

  it('3d TYPE-PRESERVING HOLLOW compiles and loses on behavioral assertions', () => {
    const source = fs.readFileSync(GUARD, 'utf8');
    const bodyStart = source.indexOf('export function evaluateStandardsDirection({');
    const bodyEnd = source.indexOf('\n}\n\n/** Fail-closed protected-base registry acquisition', bodyStart);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const signatureEnd = source.indexOf('}) {', bodyStart) + 4;
    const passingBody = `
  // P3d TYPE-PRESERVING HOLLOW: fabricated all-clear with the real API intact.
  return {
    status: 'passed',
    errors: [],
    baseRevision,
    baseRegistrySha256: '0'.repeat(64),
    candidateRegistrySha256: '0'.repeat(64),
    changes: [],
    population: {
      protectedBase: 1,
      candidate: 1,
      continuity: 1,
      additions: [],
      removals: [],
      byFamily: {},
    },
  };
`;
    const sabotaged = `${source.slice(0, signatureEnd)}${passingBody}${source.slice(bodyEnd)}`;
    fs.writeFileSync(path.join(tmp, 'standards-direction-guard.mjs'), sabotaged);
    const applied = fs.readFileSync(path.join(tmp, 'standards-direction-guard.mjs'), 'utf8');
    expect(applied).toContain('export function evaluateStandardsDirection({');
    expect(applied).toContain('P3d TYPE-PRESERVING HOLLOW');
    expect(applied).not.toContain('const base = inventoryStandardsArticles(baseMarkdown);');

    const run = contractRun();
    reportP3('3d-type-preserving-hollow', run);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain('Tests  3 failed (3)');
    expect(run.output).toMatch(/expected 'passed' to be 'not-proven'/);
  });
});
