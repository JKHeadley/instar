import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { rawSecretMatches } from '../../src/core/durableSecretScrub.js';
import { buildConstitutionReviewSubject, prepareConstitutionReview, corroborateConstitutionReview } from '../../skills/instar-dev/scripts/constitutional-review.mjs';
import { checkGoverningSources } from '../../scripts/check-constitution-pairing.mjs';
import { buildFeedbackReviewPort } from '../../src/feedback-factory/execute/buildFeedbackExecutor.js';
import { resolveGoverningConstitution } from '../../src/core/standardsRegistryPath.js';
import { CONTEXT_BUDGET_BYTES, type ReviewerConfig } from '../../src/core/crossModelReviewer.js';

describe('all-tier constitutional review subject and advisory', () => {
  let root: string;
  const git = (args: string[]) => SafeGitExecutor.execSync(args, { cwd: root, stdio: 'ignore', operation: 'tests/unit/constitutional-change-review.test.ts:git' });
  const write = (name: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  const context = { checkerIdentity: 'checker-1', governing: { available: true, identity: 'source-1' } };
  const response = (x: unknown) => ({ ok: true, json: async () => x });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'constitutional-change-'));
    git(['init', '-q']);
    write('.instar/config.json', JSON.stringify({ projectName: 'fixture-agent', port: 4042 }));
    write('src/widget.ts', 'export const widget = 1;\n');
    git(['add', 'src/widget.ts']);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/constitutional-change-review.test.ts:cleanup' }));

  function ports(fetchImpl: any) { return { agentHome: root, token: 'fixture-auth', secretDetector: rawSecretMatches, fetch: fetchImpl }; }
  const report = (next = context) => ({ degraded: false, findings: [{ standard: 'Rule 10', reason: 'A phrase detector is being given semantic authority.' }], checkedAt: '2026-11-18T00:00:00Z', ...next });

  it('does not hash its own trace or side-effects assessment, but detects a real source edit', () => {
    const options = { artifactPath: 'upgrades/side-effects/widget.md' };
    const first = buildConstitutionReviewSubject(root, options);
    write('.instar/instar-dev-traces/a.json', '{"review":"first"}');
    write(options.artifactPath, '# independent assessment');
    git(['add', '.instar/instar-dev-traces/a.json', options.artifactPath]);
    const next = buildConstitutionReviewSubject(root, options);
    expect(next.inputSha256).toBe(first.inputSha256);
    expect(next.excludedPaths).toHaveLength(2);
    write('src/widget.ts', 'export const widget = 2;\n'); git(['add', 'src/widget.ts']);
    expect(buildConstitutionReviewSubject(root, options).inputSha256).not.toBe(first.inputSha256);
  });

  it('includes both sides of a rename and never lets Git attributes hide source', () => {
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture base']);
    git(['mv', 'src/widget.ts', 'src/renamed.ts']);
    let subject = buildConstitutionReviewSubject(root);
    expect(subject.paths).toEqual(['src/renamed.ts', 'src/widget.ts']);
    expect(subject.markdown).toContain('deleted file mode');
    expect(subject.markdown).toContain('new file mode');
    write('.gitattributes', '*.ts -diff\n'); git(['add', '.gitattributes']);
    subject = buildConstitutionReviewSubject(root);
    expect(subject.markdown).toContain('+export const widget = 1');
    expect(subject.markdown).not.toContain('Binary files ');
  });

  it('reports unsupported old binary content even when its replacement is valid UTF-8', () => {
    write('src/widget.ts', Buffer.from([0, 255, 1])); git(['add', 'src/widget.ts']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'binary base']);
    write('src/widget.ts', 'export const replacement = true;'); git(['add', 'src/widget.ts']);
    expect(buildConstitutionReviewSubject(root).unsupportedPaths).toContain('src/widget.ts');
  });

  it('submits only complete source, reuses completed checks, and invalidates a changed checker contract', async () => {
    let identity = context;
    const request = vi.fn(async (url: string) => response(url.endsWith('/metrics') ? {} : url.endsWith('conformance-metrics') ? { context: identity } : { report: report(identity) }));
    const first = await prepareConstitutionReview(root, {}, ports(request));
    expect(first.status).toBe('checked');
    const second = await prepareConstitutionReview(root, {}, ports(request));
    expect(second.reused).toBe(true);
    expect(request.mock.calls.filter(([u]) => u.endsWith('conformance-check'))).toHaveLength(1);
    identity = { ...context, checkerIdentity: 'checker-2' };
    await prepareConstitutionReview(root, {}, ports(request));
    expect(request.mock.calls.filter(([u]) => u.endsWith('conformance-check'))).toHaveLength(2);
  });

  it('retries unchanged input after an unavailable invocation recovers', async () => {
    const broken = vi.fn(async () => { throw new Error('fixture outage'); });
    expect(await prepareConstitutionReview(root, {}, ports(broken))).toMatchObject({ status: 'unavailable' });
    const recovered = vi.fn(async (url: string) => response(url.endsWith('conformance-metrics') ? { context } : { report: report() }));
    expect(await prepareConstitutionReview(root, {}, ports(recovered))).toMatchObject({ status: 'checked' });
  });

  it('corroborates the current source and checker at commit time and rejects malformed cached reports', async () => {
    let current = context;
    const request = vi.fn(async (url: string, options: any) => {
      expect(options.redirect).toBe('error');
      return response(url.endsWith('conformance-metrics') ? { context: current } : { report: report(current) });
    });
    const first = await prepareConstitutionReview(root, {}, ports(request));
    expect(await corroborateConstitutionReview(root, first, {}, ports(request))).toMatchObject({ fresh: true });
    current = { ...context, checkerIdentity: 'updated-checker' };
    expect(await corroborateConstitutionReview(root, first, {}, ports(request))).toMatchObject({ fresh: false, reason: 'source-or-checker-changed-since-review' });
    const file = path.join(root, '.instar/state/build/constitutional-review.json');
    const broken = { ...first, checkerIdentity: current.checkerIdentity, report: { ...report(current), degraded: true } };
    fs.writeFileSync(file, JSON.stringify(broken));
    const fresh = await prepareConstitutionReview(root, {}, ports(request));
    expect(fresh.reused).not.toBe(true);
    expect(fresh.report.degraded).toBe(false);
  });

  it('makes no HTTP request for a staged credential or unsupported binary', async () => {
    const request = vi.fn();
    write('src/widget.ts', `const token = "ghp_${'A'.repeat(36)}";\n`); git(['add', 'src/widget.ts']);
    const sensitive = await prepareConstitutionReview(root, {}, ports(request));
    expect(sensitive).toMatchObject({ status: 'unavailable', reason: 'sensitive-input' });
    expect(JSON.stringify(sensitive)).not.toContain('ghp_');
    expect(request).not.toHaveBeenCalled();
    write('src/widget.ts', Buffer.from([0, 255, 1])); git(['add', 'src/widget.ts']);
    expect(await prepareConstitutionReview(root, {}, ports(request))).toMatchObject({ status: 'unavailable', reason: 'unsupported-content' });
    expect(request).not.toHaveBeenCalled();
  });

  it('never retains or prints credential-shaped model output', async () => {
    const request = vi.fn(async (url: string) => response(url.endsWith('conformance-metrics') ? { context } : { report: { ...report(), findings: [{ standard: 'Rule 10', reason: `ghp_${'B'.repeat(36)}` }] } }));
    const result = await prepareConstitutionReview(root, {}, ports(request));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'sensitive-response' });
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });

  it('withholds sensitive excluded filenames before HTTP or cache retention', async () => {
    const key = `ghp_${'C'.repeat(36)}`;
    const file = `.instar/instar-dev-traces/${key}.json`;
    write(file, '{}'); git(['add', file]);
    const request = vi.fn();
    const result = await prepareConstitutionReview(root, {}, ports(request));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'sensitive-input', excludedPaths: [], withheldPathCount: 1 });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(request).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.instar/state/build/constitutional-review.json'))).toBe(false);
  });

  it('never returns unchecked filenames when the trusted detector fails', async () => {
    const key = `ghp_${'D'.repeat(36)}`;
    const file = `.instar/instar-dev-traces/${key}.json`;
    write(file, '{}'); git(['add', file]);
    const request = vi.fn();
    const result = await prepareConstitutionReview(root, {}, { ...ports(request), secretDetector: () => { throw new Error('fixture detector outage'); } });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'secret-detector-unavailable', excludedPaths: [], withheldPathCount: 1 });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(request).not.toHaveBeenCalled();
  });

  it('withholds sensitive unsupported filenames rather than returning binary-path metadata', async () => {
    const key = `ghp_${'E'.repeat(36)}`;
    const file = `src/${key}.bin`;
    write(file, Buffer.from([0, 255, 1])); git(['add', file]);
    const request = vi.fn();
    const result = await prepareConstitutionReview(root, {}, ports(request));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'sensitive-input' });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.unsupportedPaths).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing cached metadata and updates safe exclusions on reuse', async () => {
    const request = vi.fn(async (url: string) => response(url.endsWith('conformance-metrics') ? { context } : { report: report() }));
    const file = '.instar/instar-dev-traces/first.json';
    write(file, '{}'); git(['add', file]);
    const first = await prepareConstitutionReview(root, {}, ports(request));
    const cache = path.join(root, '.instar/state/build/constitutional-review.json');
    const key = `ghp_${'F'.repeat(36)}`;
    fs.writeFileSync(cache, JSON.stringify({ ...first, excludedPaths: [`.instar/instar-dev-traces/${key}.json`] }));
    const repaired = await prepareConstitutionReview(root, {}, ports(request));
    expect(repaired).toMatchObject({ status: 'checked', excludedPaths: [file] });
    expect(repaired.reused).not.toBe(true);
    expect(JSON.stringify(repaired)).not.toContain(key);
    expect(fs.readFileSync(cache, 'utf8')).not.toContain(key);
    const added = '.instar/instar-dev-decisions/second.json';
    write(added, '{}'); git(['add', added]);
    const reused = await prepareConstitutionReview(root, {}, ports(request));
    expect(reused.reused).toBe(true);
    expect(reused.excludedPaths).toEqual([added, file]);
    expect(request.mock.calls.filter(([url]) => url.endsWith('conformance-check'))).toHaveLength(2);
  });
});

describe('snapshot provenance', () => {
  it('rejects co-edited source/hash and a matching source at an unmerged commit', () => {
    const directory = path.join(process.cwd(), 'src/data/constitution');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'sources.json'), 'utf8'));
    const gh = (args: string[]) => {
      const url = args[1];
      if (url.includes('/compare/')) return JSON.stringify({ status: 'ahead', merge_base_commit: { sha: metadata.commit } });
      const doc = metadata.documents.find((d: any) => url.includes(d.path));
      return JSON.stringify({ content: fs.readFileSync(path.join(directory, doc.file)).toString('base64') });
    };
    expect(checkGoverningSources(directory, { ghFn: gh }).state).toBe('verified-pinned-source');
    expect(checkGoverningSources(directory, { ghFn: (args: string[]) => args[1].includes('/compare/') ? JSON.stringify({ status: 'diverged', merge_base_commit: { sha: '0'.repeat(40) } }) : gh(args) })).toMatchObject({ state: 'unknown', reason: 'source-not-on-protected-main' });
    expect(checkGoverningSources(directory, { ghFn: (args: string[]) => args[1].includes('/compare/') ? gh(args) : JSON.stringify({ content: Buffer.from('different upstream bytes').toString('base64') }) })).toMatchObject({ state: 'unknown', reason: 'upstream-bytes-mismatch' });
  });
});

describe('existing executor review retains safety coverage', () => {
  const config = { specConverge: { reviewers: { anthropic: { model: 'claude-opus-5-5' } } } } as ReviewerConfig;
  const invoke = (seen: any[]) => (async (input: any) => { seen.push(input); return { status: 'ok', framework: input.family, model: 'fixture', verdict: 'CLEAN', findings: [], flag: 'fixture', crossFamily: true }; }) as any;
  it('supplies the complete trusted pair and records supplied rather than claiming it was read', async () => {
    const seen: any[] = [];
    const outcomes = await buildFeedbackReviewPort(config, invoke(seen)).run({ prompt: 'SAFETY INPUT', lead: 'astra' });
    expect(seen[0].assembled.promptText).toContain('Make coherence something an AI cannot lose');
    expect(seen[0].assembled.promptText).toContain('One Provider Is Enough');
    expect(seen[0].assembled.promptText).toContain('SAFETY INPUT');
    expect(outcomes[0].constitutionalReview?.context).toBe('supplied');
  });
  it('keeps the whole safety input when the pair cannot fit, without claiming constitutional review', async () => {
    const seen: any[] = []; const safety = 'S'.repeat(192 * 1024);
    const outcomes = await buildFeedbackReviewPort(config, invoke(seen)).run({ prompt: safety, lead: 'astra' });
    expect(seen[0].assembled.promptText.endsWith(safety)).toBe(true);
    expect(seen[0].assembled.promptText).not.toContain('Make coherence something an AI cannot lose');
    expect(seen[0].assembled.truncated).toBe(false);
    expect(outcomes[0].constitutionalReview).toMatchObject({ context: 'unavailable', reason: 'complete-context-too-large' });
    const source = resolveGoverningConstitution(); expect(source.usable).toBe(true);
  });
  it('marks an oversized original safety input incomplete rather than calling it complete', async () => {
    const seen: any[] = [];
    await buildFeedbackReviewPort(config, invoke(seen)).run({ prompt: 'S'.repeat(CONTEXT_BUDGET_BYTES + 1), lead: 'astra' });
    expect(seen[0].assembled.truncated).toBe(true);
    expect(seen[0].assembled.omittedLoadBearing).toContain('complete-original-safety-input');
  });
});
