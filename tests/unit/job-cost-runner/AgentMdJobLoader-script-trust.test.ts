/**
 * job-cost-reduction §5.1 lock-file trust for script jobs: a script job is
 * `trusted` only when the body hash AND the script hash match; a script-hash
 * mismatch keeps the job LOADED but untrusted (so the scheduler records a
 * failed run and alerts); verifyScriptHash is the re-hash the scheduler runs
 * before every execution.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildSyntheticAgent, mkManifest, type SyntheticAgent } from '../scheduler/agentmd-helpers.js';
import { hashBody, hashFrontmatter, hashScriptBytes } from '../../../src/scheduler/AgentMdLockFile.js';

const lockState: { value: unknown } = { value: { state: 'absent' } };
vi.mock('../../../src/scheduler/AgentMdLockFile.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/scheduler/AgentMdLockFile.js')>();
  return { ...orig, readLockFile: () => lockState.value };
});

const { loadAgentMdJobs, verifyScriptHash } = await import('../../../src/scheduler/AgentMdJobLoader.js');

const FM_TEXT = [
  'name: "Probe"',
  'description: "probe job"',
  'toolAllowlist: "*"',
  'unrestrictedTools: "true"',
  'runner: "script"',
  'script: "probe.mjs"',
  'scriptSupervision: "deterministic"',
].join('\n');
const BODY = 'Probe body\n';
const SCRIPT = 'console.log("JOB_RESULT ok")\n';

let agent: SyntheticAgent | undefined;
afterEach(() => { agent?.cleanup(); agent = undefined; lockState.value = { state: 'absent' }; });

function setup(): SyntheticAgent {
  agent = buildSyntheticAgent({
    manifests: { probe: mkManifest({ slug: 'probe', execute: { type: 'script', value: 'probe.mjs' } }) },
    instarMd: { probe: `---\n${FM_TEXT}\n---\n${BODY}` },
    extras: { 'jobs/instar/scripts/probe.mjs': SCRIPT },
  });
  return agent;
}

function trustedLock(scriptHash: string | undefined) {
  const fm = yaml.load(FM_TEXT, { schema: yaml.FAILSAFE_SCHEMA }) as Record<string, unknown>;
  const entry: Record<string, string> = { slug: 'probe', bodyHash: hashBody(BODY), frontmatterHash: hashFrontmatter(fm) };
  if (scriptHash) entry.scriptHash = scriptHash;
  return { state: 'present-trusted', lockFile: {}, bySlug: new Map([['probe', entry]]) };
}

describe('script job lock-file trust', () => {
  it('no lock-file → loads as untrusted-no-lockfile (runs, like an unsigned agentmd default)', () => {
    const a = setup();
    const r = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
    expect(r.jobs[0]).toMatchObject({ slug: 'probe', runner: 'script', lockTrust: 'untrusted-no-lockfile' });
  });

  it('body + script hash match → trusted, with the expected hash carried for re-hash', () => {
    const a = setup();
    lockState.value = trustedLock(hashScriptBytes(SCRIPT));
    const r = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
    expect(r.jobs[0].lockTrust).toBe('trusted');
    expect(r.jobs[0].scriptHashExpected).toBe(hashScriptBytes(SCRIPT));
  });

  it('script hash mismatch → loaded but untrusted-hash-mismatch, with a problem', () => {
    const a = setup();
    lockState.value = trustedLock(hashScriptBytes('something else'));
    const r = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0].lockTrust).toBe('untrusted-hash-mismatch');
    expect(r.jobs[0].scriptHashExpected).toBeUndefined();
    expect(r.problems.some((p) => /failed verification/.test(p.message))).toBe(true);
  });

  it('lock entry with no scriptHash → untrusted (body match alone is not enough)', () => {
    const a = setup();
    lockState.value = trustedLock(undefined);
    const r = loadAgentMdJobs(a.scheduleDir, a.jobsRoot);
    expect(r.jobs[0].lockTrust).toBe('untrusted-hash-mismatch');
  });

  it('bad signature → untrusted-bad-signature; not in lock-file → untrusted-not-in-lockfile', () => {
    const a = setup();
    lockState.value = { state: 'present-untrusted', lockFile: {}, reason: 'bad' };
    expect(loadAgentMdJobs(a.scheduleDir, a.jobsRoot).jobs[0].lockTrust).toBe('untrusted-bad-signature');
    lockState.value = { state: 'present-trusted', lockFile: {}, bySlug: new Map() };
    expect(loadAgentMdJobs(a.scheduleDir, a.jobsRoot).jobs[0].lockTrust).toBe('untrusted-not-in-lockfile');
  });

  it('frontmatter missing runner: script is refused (never half-understood)', () => {
    agent = buildSyntheticAgent({
      manifests: { probe: mkManifest({ slug: 'probe', execute: { type: 'script', value: 'probe.mjs' } }) },
      instarMd: { probe: '---\nname: "Probe"\n---\nbody\n' },
    });
    const r = loadAgentMdJobs(agent.scheduleDir, agent.jobsRoot);
    expect(r.jobs).toEqual([]);
    expect(r.problems[0].kind).toBe('agentmd-frontmatter-invalid');
  });

  it('a user-origin script manifest does not take the script-runner branch', () => {
    agent = buildSyntheticAgent({
      manifests: { mine: mkManifest({ slug: 'mine', origin: 'user', execute: { type: 'script', value: 'echo hi' } }) },
    });
    const r = loadAgentMdJobs(agent.scheduleDir, agent.jobsRoot);
    expect(r.jobs[0].runner).toBeUndefined();
    expect(r.jobs[0].execute).toEqual({ type: 'script', value: 'echo hi' });
  });
});

describe('verifyScriptHash (re-hash before every execution)', () => {
  it('detects a file changed after loading', () => {
    const a = setup();
    const p = path.join(a.jobsRoot, 'instar', 'scripts', 'probe.mjs');
    const h = hashScriptBytes(SCRIPT);
    expect(verifyScriptHash(p, h)).toEqual({ ok: true });
    fs.appendFileSync(p, '// changed\n');
    expect(verifyScriptHash(p, h).ok).toBe(false);
  });

  it('refuses a symlinked script and a missing expected hash', () => {
    const a = setup();
    const p = path.join(a.jobsRoot, 'instar', 'scripts', 'probe.mjs');
    const link = path.join(a.jobsRoot, 'instar', 'scripts', 'link.mjs');
    fs.symlinkSync(p, link);
    expect(verifyScriptHash(link, hashScriptBytes(SCRIPT)).ok).toBe(false);
    expect(verifyScriptHash(p, undefined).ok).toBe(false);
  });
});
