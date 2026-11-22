// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * job-mode-instructions (docs/specs/job-mode-instructions.md): rendering, mode resolution, launch
 * flags, the transcript check, per-job check state, the positive control, and migration carry-over.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  generateJobModeText, jobModeMarker, resolveInstructionsMode, judgeJobModeTranscript, judgeTranscriptFile,
  findClaudeTranscript, isExcludedSource,
} from '../../src/scheduler/jobModeInstructions.js';
import { jobModeRestriction, jobModeSettingsJson } from '../../src/scheduler/jobModeLaunch.js';
import { claudeHeadlessExtraFlags } from '../../src/core/frameworkSessionLaunch.js';
import { JobModeCheckStore, UNKNOWN_RETRY_LIMIT, PROBE_STALE_MS } from '../../src/scheduler/jobModeCheckStore.js';
import { JobModePositiveControl, judgeControl, listedSources } from '../../src/scheduler/jobModePositiveControl.js';
import { carryInstructionsOverride, undoCarriedInstructionsOverrides } from '../../src/commands/jobMigrate.js';
import {
  SHARED_CLAUSE_CITE_WITH_SOURCE, SHARED_CLAUSE_NO_COMMANDS_TO_USER, SHARED_CLAUSE_NO_INTERACTIVE_COMMANDS,
  SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES, generateClaudeMd,
} from '../../src/scaffold/templates.js';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobmode-unit-'))); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/job-mode-instructions.test.ts' }); });

describe('generateJobModeText (Change 1)', () => {
  const text = generateJobModeText({ agentName: 'echo', instarVersion: '1.2.3' });

  it('carries every required topic and ends with the marker', () => {
    expect(text).toContain('unattended scheduled job');
    expect(text).toContain('$INSTAR_SERVER_URL');
    expect(text).toContain('$INSTAR_AUTH_TOKEN');
    expect(text).toContain('POST /feedback');
    expect(text).toMatch(/CLAUDE\.md, AGENTS\.md\) and its memory index were NOT loaded/);
    expect(text).toContain('.instar/reference/INDEX.md');
    expect(text.trim().split('\n').pop()).toBe(jobModeMarker('1.2.3'));
    console.log(`[job-mode] rendered text size: ${Buffer.byteLength(text)} bytes`);
  });

  it('renders the exact shared safety and disclosure clauses that CLAUDE.md renders', () => {
    for (const clause of [SHARED_CLAUSE_NO_INTERACTIVE_COMMANDS, SHARED_CLAUSE_CITE_WITH_SOURCE,
      SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES, SHARED_CLAUSE_NO_COMMANDS_TO_USER]) {
      expect(text).toContain(clause);
    }
    const claudeMd = generateClaudeMd('proj', 'echo', 4042, false);
    for (const clause of [SHARED_CLAUSE_NO_INTERACTIVE_COMMANDS, SHARED_CLAUSE_PLAIN_COMPLETE_MESSAGES, SHARED_CLAUSE_NO_COMMANDS_TO_USER]) {
      expect(claudeMd).toContain(clause);
    }
  });

  it('holds no per-machine value', () => {
    expect(text).not.toMatch(/localhost:\d+/);
  });
});

describe('resolveInstructionsMode (Change 3)', () => {
  const reviewed = [{ slug: 'shipped', bodyHash: 'sha256:aaa' }];
  it('override beats field beats default, keyed by origin and slug', () => {
    expect(resolveInstructionsMode({ slug: 'j', bodyHash: null, field: 'full' }, { 'user:j': 'job-mode' })).toMatchObject({ mode: 'job-mode', source: 'override' });
    expect(resolveInstructionsMode({ slug: 'j', bodyHash: null, field: 'job-mode' }, {})).toMatchObject({ mode: 'job-mode', source: 'field' });
    expect(resolveInstructionsMode({ slug: 'j', bodyHash: null }, {})).toMatchObject({ mode: 'full', source: 'default' });
  });
  it('a verified shipped job defaults to job-mode only when its slug and body hash are reviewed', () => {
    const base = { slug: 'shipped', origin: 'instar' as const, lockTrust: 'trusted', bodyHash: 'sha256:aaa' };
    expect(resolveInstructionsMode(base, {}, reviewed).mode).toBe('job-mode');
    expect(resolveInstructionsMode({ ...base, bodyHash: 'sha256:changed' }, {}, reviewed).mode).toBe('full');
    expect(resolveInstructionsMode({ ...base, lockTrust: 'untrusted-hash-mismatch' }, {}, reviewed).mode).toBe('full');
    expect(resolveInstructionsMode({ ...base, slug: 'newly-shipped' }, {}, reviewed).mode).toBe('full');
  });
  it('user and legacy jobs default to full; an instar override never applies to a user fork', () => {
    expect(resolveInstructionsMode({ slug: 'shipped', origin: 'user', bodyHash: 'sha256:aaa' }, { 'instar:shipped': 'job-mode' }, reviewed).mode).toBe('full');
  });
  it('the jobs.json field is ignored for agentmd jobs (no frontmatter field)', () => {
    expect(resolveInstructionsMode({ slug: 'm', origin: 'user', bodyHash: 'sha256:x', field: 'job-mode' }, {}).mode).toBe('full');
  });
  it('an invalid value resolves that job to full and is reported, never thrown', () => {
    const r1 = resolveInstructionsMode({ slug: 'j', bodyHash: null }, { 'user:j': 'jobmode' });
    expect(r1).toMatchObject({ mode: 'full' });
    expect(r1.invalid).toContain('jobmode');
    const r2 = resolveInstructionsMode({ slug: 'j', bodyHash: null, field: 7 }, undefined);
    expect(r2.mode).toBe('full');
    expect(r2.invalid).toBeDefined();
  });
});

describe('launch flags (Changes 4-5)', () => {
  const jobMode = { agentHome: '/agent', text: 'T\nJOB-MODE-MARKER instar 1', sessionId: '11111111-1111-4111-8111-111111111111' };
  it('Claude Code gets the exclusion settings, the inline text and the session id', () => {
    const f = claudeHeadlessExtraFlags({ framework: 'claude-code', jobMode });
    expect(f).toEqual(['--settings', jobModeSettingsJson('/agent'), '--append-system-prompt', jobMode.text, '--session-id', jobMode.sessionId]);
    expect(JSON.parse(jobModeSettingsJson('/agent')).claudeMdExcludes).toEqual(['/agent/CLAUDE.md', '/agent/AGENTS.md', '/agent/.claude/CLAUDE.md']);
  });
  it('Codex gets nothing; a confinement settings file always wins (one --settings)', () => {
    expect(claudeHeadlessExtraFlags({ framework: 'codex-cli', jobMode })).toEqual([]);
    const f = claudeHeadlessExtraFlags({ framework: 'claude-code', jobMode, confinementSettingsPath: '/s.json' });
    expect(f.filter(x => x === '--settings')).toHaveLength(1);
    expect(f).not.toContain('--append-system-prompt');
  });
  it('restriction reasons', () => {
    expect(jobModeRestriction({})).toBeNull();
    expect(jobModeRestriction({ confinement: {} })).toBe('confinement');
    expect(jobModeRestriction({ confinedTools: ['Read'] })).toBe('confined-tools');
    expect(jobModeRestriction({ requireToolConfinement: true })).toBe('require-tool-confinement');
    expect(jobModeRestriction({ omitAuthEnv: true })).toBe('no-auth-env');
  });
});

describe('transcript check (Change 6)', () => {
  const home = '/agent';
  const marker = 'JOB-MODE-MARKER instar 1.2.3';
  const line = (o: unknown) => JSON.stringify(o);
  const snapshot = (withMarker: boolean) => line({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: withMarker ? ['base prompt', `x ${marker}`] : ['base prompt', 'x'] } });
  const instructions = (paths: string[]) => line({ type: 'attachment', attachment: { type: 'instructions', files: paths.map(p => ({ path: p })) } });
  const reply = line({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: 'OK' } });

  it('a later unrecognised snapshot resets the decision to unknown', () => {
    const odd = line({ type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: 'x' } });
    const v = judgeJobModeTranscript([snapshot(true), odd, line({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } })].join('\n'), { agentHome: '/agent', marker });
    expect(v.verdict).toBe('unknown');
  });

  it('a placeholder or error assistant record cannot certify a pass', () => {
    const synth = line({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } });
    expect(judgeJobModeTranscript([snapshot(true), synth].join('\n'), { agentHome: '/agent', marker }).verdict).toBe('unknown');
    const err = line({ type: 'assistant', isApiErrorMessage: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } });
    expect(judgeJobModeTranscript([snapshot(true), err].join('\n'), { agentHome: '/agent', marker }).verdict).toBe('unknown');
  });

  it('the last snapshot before the reply decides: a later snapshot without the marker fails', () => {
    const v = judgeJobModeTranscript([snapshot(true), snapshot(false), line({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } })].join('\n'), { agentHome: '/agent', marker });
    expect(v.verdict).toBe('fail');
  });

  it('the marker counts only inside the snapshot\'s system prompt list', () => {
    const elsewhere = line({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['base prompt'], note: marker } });
    const v = judgeJobModeTranscript([elsewhere, line({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } })].join('\n'), { agentHome: '/agent', marker });
    expect(v.verdict).toBe('fail');
    const unrecognised = line({ type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: marker } });
    const u = judgeJobModeTranscript([unrecognised, line({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } })].join('\n'), { agentHome: '/agent', marker });
    expect(u.verdict).toBe('unknown');
  });
  it('pass: no instructions entry at all (observed when nothing loads), marker present, first reply reached', () => {
    expect(judgeJobModeTranscript([snapshot(true), reply].join('\n'), { agentHome: home, marker }).verdict).toBe('pass');
  });
  it('fail: CLAUDE.md, AGENTS.md or the memory index listed', () => {
    for (const p of ['/agent/CLAUDE.md', '/agent/AGENTS.md', '/home/u/.claude/projects/x/memory/MEMORY.md']) {
      const j = judgeJobModeTranscript([instructions([p]), snapshot(true), reply].join('\n'), { agentHome: home, marker });
      expect(j.verdict).toBe('fail');
    }
  });
  it('an excluded file listed under a symlink alias still fails the check', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-home-'));
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'x');
    const alias = path.join(os.tmpdir(), `jm-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(home, alias);
    try {
      const listed = line({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: path.join(alias, 'CLAUDE.md') }] } });
      expect(judgeJobModeTranscript([listed, snapshot(true), reply].join('\n'), { agentHome: home, marker }).verdict).toBe('fail');
    } finally { SafeFsExecutor.safeUnlinkSync(alias, { operation: 'test: remove symlink alias' }); SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'test: remove home' }); }
  });

  it('another project\'s CLAUDE.md does not fail the check (resolved path match)', () => {
    expect(isExcludedSource('/other/CLAUDE.md', home)).toBe(false);
    expect(judgeJobModeTranscript([instructions(['/other/CLAUDE.md']), snapshot(true), reply].join('\n'), { agentHome: home, marker }).verdict).toBe('pass');
  });
  it('fail: a first-turn snapshot without the marker', () => {
    expect(judgeJobModeTranscript([snapshot(false), reply].join('\n'), { agentHome: home, marker }).verdict).toBe('fail');
  });
  it('unknown: truncated after a marker-bearing snapshot but before the first reply', () => {
    expect(judgeJobModeTranscript([snapshot(true), '{"type":"attach'].join('\n'), { agentHome: home, marker, truncated: true }).verdict).toBe('unknown');
  });
  it('unknown: missing transcript', () => {
    expect(judgeTranscriptFile(null, { agentHome: home, marker }).verdict).toBe('unknown');
    expect(judgeTranscriptFile(path.join(tmp, 'nope.jsonl'), { agentHome: home, marker }).verdict).toBe('unknown');
  });
  it('finds a transcript under any candidate config home', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const dir = path.join(tmp, 'home2', 'projects', '-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '');
    expect(findClaudeTranscript(id, '/agent', [path.join(tmp, 'home1'), path.join(tmp, 'home2')])).toBe(path.join(dir, `${id}.jsonl`));
    expect(findClaudeTranscript('../etc', '/agent', [tmp])).toBeNull();
  });
});

function fakeProbeRun(configHome: string) {
  return async (args: string[], cwd: string) => {
    const id = args[args.indexOf('--session-id') + 1];
    const settingsAt = args.indexOf('--settings');
    const settings = settingsAt >= 0 ? JSON.parse(args[settingsAt + 1]) : null;
    const files: string[] = [];
    const excluded: string[] = settings?.claudeMdExcludes ?? [];
    for (const f of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) if (!excluded.includes(path.join(cwd, f))) files.push(path.join(cwd, f));
    if (excluded.includes(path.join(cwd, 'CLAUDE.md')) && !excluded.includes(path.join(cwd, 'AGENTS.md'))) files.push(path.join(cwd, 'AGENTS.md'));
    if (!settings || settings.autoMemoryEnabled !== false) files.push(path.join(configHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md'));
    const dir = path.join(configHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const lines = files.length ? [JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: files.map(p => ({ path: p })) } })] : [];
    lines.push(JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 6_666 + files.length * 4_950, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n'));
  };
}

describe('JobModeCheckStore (Change 6 state)', () => {
  const VP = '1.0|2.0';
  it('first run checks; a pass stops further checks on that version pair', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    expect(d).toMatchObject({ launch: 'job-mode', check: true });
    await s.recordResult('user:j', d.generation, VP, 'pass');
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'job-mode', check: false });
  });
  it('a fail suppresses job-mode locally; a version change allows one probe; a passing probe resumes', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    const r = await s.recordResult('user:j', d.generation, VP, 'fail');
    expect(r.newlyFailed).toBe(true);
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'full' });
    const probe = await s.decideLaunch('user:j', '1.1|2.0');
    expect(probe).toMatchObject({ launch: 'job-mode', check: true });
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' }); // only one probe
    await s.recordResult('user:j', probe.generation, '1.1|2.0', 'pass', undefined, (probe as { probeId?: number }).probeId);
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'job-mode' });
  });
  it('a late verdict from an earlier stint of the same version pair (A -> B -> A) is discarded', async () => {
    const s = new JobModeCheckStore(tmp);
    const first = await s.decideLaunch('user:j', VP);
    await s.decideLaunch('user:j', '9.9|2.0');
    const again = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', again.generation, VP, 'pass');
    const late = await s.recordResult('user:j', first.generation, VP, 'fail');
    expect(late.applied).toBe(false);
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'job-mode' });
  });
  it('a fail removes that combination\'s earlier pass', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:f', VP);
    await s.recordResult('user:f', d.generation, VP, 'pass', 'homeA#headless#2.0');
    expect(s.hasPassedUnder('user:f', VP, 'homeA#headless#2.0')).toBe(true);
    await s.recordResult('user:f', d.generation, VP, 'fail', 'homeA#headless#2.0');
    expect(s.hasPassedUnder('user:f', VP, 'homeA#headless#2.0')).toBe(false);
  });
  it('a verified pass clears the spawn-rejection count', async () => {
    const s = new JobModeCheckStore(tmp);
    for (let i = 0; i < 2; i++) {
      const d = await s.decideLaunch('user:r', VP);
      await s.recordResult('user:r', d.generation, VP, 'unknown', 'spawn-rejected');
    }
    const ok = await s.decideLaunch('user:r', VP);
    await s.recordResult('user:r', ok.generation, VP, 'pass', 'homeA#headless#2.0');
    const d3 = await s.decideLaunch('user:r', VP);
    await s.recordResult('user:r', d3.generation, VP, 'unknown', 'spawn-rejected');
    expect(await s.decideLaunch('user:r', VP)).toMatchObject({ launch: 'job-mode' });
  });
  it('unknown is retried at most the limit, then recorded once', async () => {
    const s = new JobModeCheckStore(tmp);
    let exhausted = 0;
    for (let i = 0; i < UNKNOWN_RETRY_LIMIT + 1; i++) {
      const d = await s.decideLaunch('user:j', VP);
      if (d.launch === 'job-mode' && d.check) {
        const r = await s.recordResult('user:j', d.generation, VP, 'unknown');
        if (r.exhaustedUnknown) exhausted++;
      }
    }
    expect(exhausted).toBe(1);
    // Unmeasurable counts as a failure: full instructions until a version change or clear.
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'full', reason: 'unknown-after-retries' });
    const next = await s.decideLaunch('user:j', '1.1|2.0');
    expect(next).toMatchObject({ launch: 'job-mode', check: true });
    await s.recordResult('user:j', next.generation, '1.1|2.0', 'pass');
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'job-mode', check: false });
  });
  it('an operator clear after exhausted unknowns allows a fresh check', async () => {
    const s = new JobModeCheckStore(tmp);
    for (let i = 0; i < UNKNOWN_RETRY_LIMIT; i++) {
      const d = await s.decideLaunch('user:j', VP);
      await s.recordResult('user:j', d.generation, VP, 'unknown');
    }
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'full' });
    await s.clear('user:j');
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'job-mode', check: true });
  });
  it('after a fallback, a pass from an ordinary run already in flight does not restore job-mode; only the probe does', async () => {
    const s = new JobModeCheckStore(tmp);
    const inFlight = await s.decideLaunch('user:j', VP); // an ordinary run, launched before the failure
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail', '/homes/A');
    await s.recordResult('user:j', inFlight.generation, VP, 'pass', '/homes/B'); // lands after the failure
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'full' });
    const probe = await s.decideLaunch('user:j', '1.1|2.0');
    expect(probe).toMatchObject({ launch: 'job-mode', check: true });
    await s.recordResult('user:j', probe.generation, '1.1|2.0', 'pass', '/homes/A', (probe as { probeId?: number }).probeId);
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'job-mode' });
  });

  it('a suppressed job gets at most three recovery probes per version pair, across accounts', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail');
    let probes = 0;
    for (let i = 0; i < 6; i++) {
      const p = await s.decideLaunch('user:j', '1.1|2.0');
      if (p.launch !== 'job-mode') break;
      probes++;
      await s.recordResult('user:j', p.generation, '1.1|2.0', 'unknown', i % 2 ? '/homes/A' : '/homes/B', (p as { probeId?: number }).probeId);
    }
    expect(probes).toBe(3);
  });

  it('a recovery probe lost before reporting (a restart) is offered again after it goes stale', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail');
    const probe = await s.decideLaunch('user:j', '1.1|2.0');
    expect(probe).toMatchObject({ launch: 'job-mode', check: true });
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' });
    const st = s.read('user:j');
    fs.writeFileSync(path.join(tmp, 'state', 'job-mode-checks', 'user_j.json'), JSON.stringify({ ...st, probeStartedAt: Date.now() - PROBE_STALE_MS - 1000 }));
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'job-mode', check: true });
    // repeated stale re-offers stop at the cap of three probe launches for this version pair
    for (let i = 0; i < 4; i++) {
      const cur = s.read('user:j');
      fs.writeFileSync(path.join(tmp, 'state', 'job-mode-checks', 'user_j.json'), JSON.stringify({ ...cur, probeStartedAt: Date.now() - PROBE_STALE_MS - 1000 }));
      await s.decideLaunch('user:j', '1.1|2.0');
    }
    expect(s.read('user:j').probeLaunches).toBe(UNKNOWN_RETRY_LIMIT);
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' });
  });

  it('a malformed check-state record is treated as fresh, so the next launch is checked', async () => {
    const s = new JobModeCheckStore(tmp);
    fs.mkdirSync(path.join(tmp, 'state', 'job-mode-checks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'job-mode-checks', 'user_j.json'), JSON.stringify({
      key: 'user:j', generation: 0, versionPair: VP, result: 'pass', unknownAttempts: 0, suppressed: false, probeReserved: false,
      passedConfigHomes: '/homes/A', updatedAt: 'x',
    }));
    expect(s.hasPassedUnder('user:j', VP, '/homes/A')).toBe(false);
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'job-mode', check: true });
  });

  it('a recovery probe that never ran in job mode is given back for the next launch', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail');
    const probe = await s.decideLaunch('user:j', '1.1|2.0');
    expect(probe).toMatchObject({ launch: 'job-mode', check: true });
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' }); // reserved probe used
    await s.releaseProbe('user:j', (probe as { probeId?: number }).probeId!);
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'job-mode', check: true });
  });

  it('a failure reported while a recovery probe is in flight means that probe\'s later pass cannot lift the fallback', async () => {
    const s = new JobModeCheckStore(tmp);
    const ordinary = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', ordinary.generation, VP, 'fail');
    const probe = (await s.decideLaunch('user:j', '1.1|2.0')) as { probeId?: number; generation: number };
    const other = await s.decideLaunch('user:j', '1.1|2.0'); // full launch meanwhile
    void other;
    await s.recordResult('user:j', probe.generation, '1.1|2.0', 'fail'); // an ordinary run's failure lands first
    await s.recordResult('user:j', probe.generation, '1.1|2.0', 'pass', undefined, probe.probeId); // the probe passes later
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' });
  });

  it('a late unknown from a superseded probe never reopens recovery after a newer probe failed', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail');
    const a = (await s.decideLaunch('user:j', '1.1|2.0')) as { probeId?: number; generation: number };
    await s.releaseProbe('user:j', a.probeId!); // a's slot re-offered (as if a went stale)
    const b = (await s.decideLaunch('user:j', '1.1|2.0')) as { probeId?: number; generation: number };
    await s.recordResult('user:j', b.generation, '1.1|2.0', 'fail', undefined, b.probeId);
    await s.recordResult('user:j', a.generation, '1.1|2.0', 'unknown', undefined, a.probeId); // late, superseded
    expect(s.read('user:j').probeReserved).toBe(false);
    expect(await s.decideLaunch('user:j', '1.1|2.0')).toMatchObject({ launch: 'full' });
  });

  it('a probe launch that never ran in job mode refunds its attempt, so recovery is not used up without a real probe', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'fail');
    for (let i = 0; i < 5; i++) {
      const p = (await s.decideLaunch('user:j', '1.1|2.0')) as { probeId?: number };
      expect(p).toMatchObject({ launch: 'job-mode', check: true });
      await s.releaseProbe('user:j', p.probeId!);
    }
    expect(s.read('user:j').probeLaunches).toBe(0);
  });

  it('unknown results under one account still add up when another account passes in between', async () => {
    const s = new JobModeCheckStore(tmp);
    let exhausted = false;
    for (let i = 0; i < UNKNOWN_RETRY_LIMIT; i++) {
      const d = await s.decideLaunch('user:j', VP);
      const r = await s.recordResult('user:j', d.generation, VP, 'unknown', '/homes/A');
      exhausted = exhausted || r.exhaustedUnknown;
      await s.recordResult('user:j', d.generation, VP, 'pass', '/homes/B');
    }
    expect(exhausted).toBe(true);
  });
  it('the sampled re-check count is persisted across store instances (restarts)', async () => {
    const k = '/homes/A#headless#2.1.330';
    let due = 0;
    const st = new JobModeCheckStore(tmp);
    const d = await st.decideLaunch('user:j', VP);
    for (let i = 0; i < 40; i++) {
      if (await new JobModeCheckStore(tmp).noteRunForRecheck('user:j', k, 20)) { due++; await st.recordResult('user:j', d.generation, VP, 'pass', k); }
    }
    expect(due).toBe(2);
    // a sample that is due but whose verdict never lands (restart) stays due on the next run
    for (let i = 0; i < 19; i++) await st.noteRunForRecheck('user:j', k, 20);
    expect(await st.noteRunForRecheck('user:j', k, 20)).toBe(true);
    expect(await st.noteRunForRecheck('user:j', k, 20)).toBe(true);
  });

  it('an unknown revokes that key\'s earlier pass, so the next run is checked', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'pass', '/homes/A#headless#2.1.330');
    expect(s.hasPassedUnder('user:j', VP, '/homes/A#headless#2.1.330')).toBe(true);
    await s.recordResult('user:j', d.generation, VP, 'unknown', '/homes/A#headless#2.1.330');
    expect(s.hasPassedUnder('user:j', VP, '/homes/A#headless#2.1.330')).toBe(false);
  });

  it('a pass is per account: a run under a new config home is not covered by an earlier pass', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.recordResult('user:j', d.generation, VP, 'pass', '/homes/A');
    expect(s.hasPassedUnder('user:j', VP, '/homes/A')).toBe(true);
    expect(s.hasPassedUnder('user:j', VP, '/homes/B')).toBe(false);
    expect(s.hasPassedUnder('user:j', '1.1|2.0', '/homes/A')).toBe(false); // a new version pair re-checks every account
  });
  it('a probe launched before an operator clear is discarded when it finishes after it', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await s.clear('user:j');
    const r = await s.recordResult('user:j', d.generation, VP, 'fail');
    expect(r.applied).toBe(false);
    expect(await s.decideLaunch('user:j', VP)).toMatchObject({ launch: 'job-mode', check: true });
  });
  it('overlapping completions both land under the per-job lock', async () => {
    const s = new JobModeCheckStore(tmp);
    const d = await s.decideLaunch('user:j', VP);
    await Promise.all([s.recordResult('user:j', d.generation, VP, 'unknown'), s.recordResult('user:j', d.generation, VP, 'unknown')]);
    expect(s.read('user:j').unknownAttempts).toBe(2);
  });
});

describe('positive control (Change 6)', () => {
  it('judgeControl requires every source visible when loaded, AGENTS.md on fallback, and none under full settings', () => {
    const all = new Set(['CLAUDE.md', '.claude/CLAUDE.md', 'memory']);
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: 21_507, claudeOnlyTokens: 16_393, fullTokens: 6_666 }).result).toBe('visible'); // live numbers, 2026-11-22
    // records say nothing loaded, but the token count shows the padded files still did: not visible
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: 30_000, claudeOnlyTokens: 29_000, fullTokens: 29_500 }).result).toBe('invisible');
    // one file loaded unrecorded under full settings: the per-file drop catches it
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: 21_507, claudeOnlyTokens: 16_393, fullTokens: 6_666 + 4_950 }).result).toBe('invisible');
    // the reviewer's example: any counts in which full secretly holds one file break the within-run ratio
    for (const fsz of [4_000, 5_000, 6_000]) {
      const base = 7_000;
      expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: base + 3 * fsz, claudeOnlyTokens: base + 2 * fsz, fullTokens: base + fsz }).result).toBe('invisible');
      expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: base + 3 * fsz, claudeOnlyTokens: base + 2 * fsz, fullTokens: base }).result).toBe('visible');
    }
    // the reviewer's example (f=3,500; drops 10,000 and 6,500): f is outside the expected band, so not trusted
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(), offTokens: 20_000, claudeOnlyTokens: 16_500, fullTokens: 10_000 }).result).toBe('invisible');
    // the CLAUDE.md-only probe listing an excluded file, or missing the index, is not trusted
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory', 'CLAUDE.md']), full: new Set(), offTokens: 21_507, claudeOnlyTokens: 16_393, fullTokens: 6_666 }).result).toBe('invisible');
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md']), full: new Set(), offTokens: 21_507, claudeOnlyTokens: 16_393, fullTokens: 6_666 }).result).toBe('invisible');
    // no token evidence: cannot corroborate
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set() }).result).toBe('invisible');
    expect(judgeControl({ off: new Set(['CLAUDE.md']), claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set() }).result).toBe('invisible');
    expect(judgeControl({ off: all, claudeOnly: new Set(), full: new Set() }).result).toBe('invisible');
    expect(judgeControl({ off: all, claudeOnly: new Set(['AGENTS.md', 'memory']), full: new Set(['memory']) }).result).toBe('invisible');
  });

  it('runs the probes once per Claude Code version and caches the record', async () => {
    const configHome = path.join(tmp, 'cfg');
    let runs = 0;
    const argvs: string[][] = [];
    const control = new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false',
      configHome,
      claudeVersion: async () => '2.1.330',
      run: async (args, cwd) => {
        runs++;
        argvs.push([...args]);
        await fakeProbeRun(configHome)(args, cwd);
      },
    });
    const rec = await control.ensure();
    expect(rec).toMatchObject({ claudeVersion: '2.1.330', result: 'visible' });
    await control.ensure();
    expect(runs).toBe(3);
    // only the full-settings probe (the third) pairs the exclusions with --append-system-prompt, as a real launch does
    expect(argvs.map(a => a.includes('--append-system-prompt'))).toEqual([false, false, true]);
  });

  it('an in-flight control for one version is never handed to a caller on another version', async () => {
    let v = '2.1.330';
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const seenVersions: string[] = [];
    const control = new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false', configHome: path.join(tmp, 'cfgV'), claudeVersion: async () => v,
      run: async () => { seenVersions.push(v); await gate; },
    });
    const a = control.ensure();
    await new Promise(r => setTimeout(r, 5));
    v = '2.1.331';
    const b = control.ensure();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.claudeVersion).toBe('2.1.330');
    expect(rb.claudeVersion).toBe('2.1.331');
  });

  it('a version change during the probes makes the control an error', async () => {
    let calls = 0;
    const control = new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false', configHome: path.join(tmp, 'cfgU'),
      claudeVersion: async () => (calls++ === 0 ? '2.1.330' : '2.1.331'),
      run: fakeProbeRun(path.join(tmp, 'cfgU')),
    });
    const rec = await control.ensure();
    expect(rec.result).toBe('error');
    expect(rec.detail).toContain('version changed during the probes');
  });

  it('a missing probe transcript is an error, never proof that exclusions worked', async () => {
    const control = new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false', configHome: path.join(tmp, 'cfgM'), claudeVersion: async () => '2.1.330',
      run: async () => { /* writes no transcript */ },
    });
    const rec = await control.ensure();
    expect(rec.result).toBe('error');
    let again = 0;
    const control2 = new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false', configHome: path.join(tmp, 'cfgM'), claudeVersion: async () => '2.1.330',
      run: async () => { again++; },
    });
    await control2.ensure();
    expect(again).toBe(0); // an error is not re-probed within the back-off window
  });

  it('keeps one record per Claude config home: a second account runs its own probes', async () => {
    const homes = [path.join(tmp, 'cfgA'), path.join(tmp, 'cfgB')];
    let runs = 0;
    const make = (configHome: string) => new JobModePositiveControl(tmp, {
      claudeBinary: '/bin/false', configHome, claudeVersion: async () => '2.1.330',
      run: async () => { runs++; throw new Error('probe stub'); },
    });
    const a = await make(homes[0]).ensure();
    const b = await make(homes[1]).ensure();
    expect(a.configHome).toBe(path.resolve(homes[0]));
    expect(b.configHome).toBe(path.resolve(homes[1]));
    expect(runs).toBe(2); // each home probed separately; neither reuses the other's record
    const files = fs.readdirSync(path.join(tmp, 'state', 'job-mode-checks')).filter((f) => f.startsWith('_positive-control-'));
    expect(files).toHaveLength(2);
  });

  it('listedSources stops at a record whose message role is assistant, like the job check', () => {
    const roleReply = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [] } });
    const late = JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/r/CLAUDE.md' }] } });
    expect([...listedSources([roleReply, late].join('\n'), '/r', '/m/MEMORY.md')]).toEqual([]);
  });

  it('listedSources reads only outer attachment records, like the job check', () => {
    const wrapped = JSON.stringify({ type: 'other', attachment: { type: 'instructions', files: [{ path: '/r/CLAUDE.md' }] } });
    expect([...listedSources(wrapped, '/r', '/m/MEMORY.md')]).toEqual([]);
  });

  it('listedSources reads only what precedes the first model reply', () => {
    const reply = JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 }, content: [] } });
    const late = JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/r/CLAUDE.md' }] } });
    expect([...listedSources([reply, late].join('\n'), '/r', '/m/MEMORY.md')]).toEqual([]);
  });

  it('listedSources maps paths to source roles', () => {
    const t = JSON.stringify({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/r/AGENTS.md' }, { path: '/m/MEMORY.md' }] } });
    expect([...listedSources(t, '/r', '/m/MEMORY.md')].sort()).toEqual(['AGENTS.md', 'memory']);
  });
});

describe('migration carry-over (Change 3)', () => {
  function writeConfig(cfg: unknown) { fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg)); }
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));

  it('carries an explicit value under the new origin:slug unless an override exists', () => {
    writeConfig({ scheduler: { instructionsOverrides: { 'user:kept': 'full' } } });
    expect(carryInstructionsOverride(tmp, 'instar', 'a', { instructions: 'full' })).toBe(true);
    expect(carryInstructionsOverride(tmp, 'user', 'kept', { instructions: 'job-mode' })).toBe(false);
    expect(carryInstructionsOverride(tmp, 'user', 'b', {})).toBe(false);
    expect(readConfig().scheduler.instructionsOverrides).toEqual({ 'user:kept': 'full', 'instar:a': 'full' });
  });

  it('a legacy user:<slug> override beats the moved job\'s own field (a "full" override is never lost to "job-mode")', () => {
    writeConfig({ scheduler: { instructionsOverrides: { 'user:x': 'full' } } });
    expect(carryInstructionsOverride(tmp, 'instar', 'x', { instructions: 'job-mode' })).toBe(true);
    expect(readConfig().scheduler.instructionsOverrides['instar:x']).toBe('full');
  });

  it('a renamed job carries the legacy override from its ORIGINAL slug', () => {
    writeConfig({ scheduler: { instructionsOverrides: { 'user:y': 'full' } } });
    expect(carryInstructionsOverride(tmp, 'user', 'y-user', { instructions: 'job-mode' }, 'y')).toBe(true);
    expect(readConfig().scheduler.instructionsOverrides['user:y-user']).toBe('full');
  });

  it('on a key change, an invalid legacy override carries full, and an override-only opt-in is carried', () => {
    writeConfig({ scheduler: { instructionsOverrides: { 'user:bad': 'trimmed', 'user:only': 'job-mode' } } });
    expect(carryInstructionsOverride(tmp, 'instar', 'bad', { instructions: 'job-mode' })).toBe(true);
    expect(carryInstructionsOverride(tmp, 'instar', 'only', {})).toBe(true);
    const m = readConfig().scheduler.instructionsOverrides;
    expect(m['instar:bad']).toBe('full');
    expect(m['instar:only']).toBe('job-mode');
  });

  it('abandon keeps its journal when config.json cannot be read, so a later undo still finds the override', () => {
    writeConfig({ scheduler: { instructionsOverrides: {} } });
    carryInstructionsOverride(tmp, 'instar', 'z', { instructions: 'job-mode' });
    const good = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
    fs.writeFileSync(path.join(tmp, 'config.json'), '{ not json');
    expect(undoCarriedInstructionsOverrides(tmp)).toBe(0);
    fs.writeFileSync(path.join(tmp, 'config.json'), good);
    expect(undoCarriedInstructionsOverrides(tmp)).toBe(1);
    expect(readConfig().scheduler.instructionsOverrides['instar:z']).toBeUndefined();
  });

  it('abandon removes only the overrides it created that still hold its value, leaving a later edit intact', () => {
    writeConfig({ scheduler: { instructionsOverrides: { 'user:pre': 'job-mode' } } });
    carryInstructionsOverride(tmp, 'instar', 'a', { instructions: 'full' });
    carryInstructionsOverride(tmp, 'user', 'b', { instructions: 'job-mode' });
    const cfg = readConfig(); cfg.scheduler.instructionsOverrides['user:b'] = 'full'; writeConfig(cfg); // operator edit
    expect(undoCarriedInstructionsOverrides(tmp)).toBe(1);
    expect(readConfig().scheduler.instructionsOverrides).toEqual({ 'user:pre': 'job-mode', 'user:b': 'full' });
  });
});
