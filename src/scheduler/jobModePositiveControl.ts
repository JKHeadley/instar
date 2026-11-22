/**
 * Positive control for the job-mode transcript check (docs/specs/job-mode-instructions.md, Change 6).
 *
 * Once per Claude Code version per machine, before any job-mode pass on that version is accepted,
 * tiny probes run in a temporary directory holding a CLAUDE.md, an AGENTS.md, a .claude/CLAUDE.md
 * and an auto-memory index, each with its own sentinel:
 *   - exclusions off: CLAUDE.md, .claude/CLAUDE.md and the memory index must be visible;
 *   - only CLAUDE.md excluded: AGENTS.md (the fallback) must be visible;
 *   - full job-mode settings: none may be visible.
 * If any source is invisible when it should be visible, the transcript no longer reveals loading,
 * and checks on that version are recorded as unknown, never pass.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { findClaudeTranscript, TRANSCRIPT_READ_BOUND_BYTES, isRealModelReply } from './jobModeInstructions.js';
import { newJobModeSessionId } from './jobModeLaunch.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const execFileAsync = promisify(execFile);

export type ControlResult = 'visible' | 'invisible' | 'error';
/** How long an error result is kept before the probes run again on the same version and account. */
export const CONTROL_ERROR_RETRY_MS = 6 * 60 * 60 * 1000;
/** How long a visible or invisible control result is reused before the probes run again on the same version and account. */
export const CONTROL_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The job check's transcript read bound (judgeTranscriptFile), reused so both read the same window. */
export const PROBE_READ_MAX_BYTES = TRANSCRIPT_READ_BOUND_BYTES;
export interface ControlRecord { claudeVersion: string; result: ControlResult; detail: string; at: string; configHome?: string }

/** Which instruction sources a transcript's `instructions` entries list (by basename role). */
export function listedSources(transcript: string, root: string, memoryIndex: string): Set<string> {
  const seen = new Set<string>();
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; /* @silent-fallback-ok — a malformed line is skipped */ }
    // Read only what precedes the first model reply, with the SAME rule as the job check
    // (judgeJobModeTranscript): a record whose type or message role is assistant ends the window.
    if (rec?.type === 'assistant' || rec?.message?.role === 'assistant') break; // any assistant record ends it; the probe as a whole requires a real reply (see readProbe)
    // Same record shape the job check reads (judgeJobModeTranscript): an outer `attachment` of type `instructions`.
    const files = rec?.type === 'attachment' && rec?.attachment?.type === 'instructions' ? rec.attachment.files : null;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      const p = typeof f?.path === 'string' ? path.resolve(f.path) : '';
      if (p === path.resolve(root, 'CLAUDE.md')) seen.add('CLAUDE.md');
      else if (p === path.resolve(root, 'AGENTS.md')) seen.add('AGENTS.md');
      else if (p === path.resolve(root, '.claude', 'CLAUDE.md')) seen.add('.claude/CLAUDE.md');
      else if (p === path.resolve(memoryIndex)) seen.add('memory');
    }
  }
  return seen;
}

/** Each sentinel file is padded to about this many characters, so loading it shows in the input token count. */
export const SENTINEL_PAD_CHARS = 8_000;
/**
 * Minimum input-token difference one padded sentinel file must account for. Derivation: measured live on Claude Code
 * 2.1.330 (2026-11-22), off 21,507 / claude-only 16,393 / full 6,666 input tokens, i.e. ~4,950 tokens per padded file.
 * 3,500 sits below one file's worth (so real exclusions pass with margin) and above the shortfall a single file that
 * loaded unrecorded would leave in the 3-file and 2-file comparisons (it would cut the drop by ~4,950), so it fails.
 */
export const PER_FILE_MIN_TOKENS = 3_500;
/** A short appended system prompt for the full-settings probe: exercises the real launch's flag pairing, small enough not to disturb the token arithmetic. */
export const PROBE_APPENDED_PROMPT = 'Job-mode positive-control probe. Reply as asked.';
/** Each comparison must reach this share of its expected multiple of the measured per-file size (a hidden file costs a whole share: 2/3 or 1/2). */
export const RATIO_TOLERANCE = 0.85;
/** One padded sentinel's measured size (Claude Code 2.1.330, 2026-11-22: ~4,950 tokens); a run whose f strays far from it is not trusted. */
export const EXPECTED_FILE_TOKENS = 4_950;

/** Total input tokens of the first model reply in a transcript (input + cache creation + cache read), or null. */
export function firstReplyInputTokens(transcript: string): number | null {
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; /* @silent-fallback-ok — a malformed line is skipped */ }
    if (rec?.type === 'assistant' || rec?.message?.role === 'assistant') {
      const u = rec?.message?.usage;
      if (!u) return null;
      const n = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      return n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * Whether the probes must run again (pure, the controller's brake): yes when there is no record for this version and
 * account; a non-error result is reused for CONTROL_RESULT_MAX_AGE_MS (then proven again, so a same-version change in
 * how transcripts record loads is eventually caught); an error is retried at most every CONTROL_ERROR_RETRY_MS (each
 * attempt is three small model calls). The record is persisted, so a restart keeps the same pace.
 */
export function controlRerunDue(rec: ControlRecord | null, version: string, configHome: string, nowMs: number): boolean {
  if (!rec) return true;
  const sameReader = rec.claudeVersion === version && (rec.configHome === undefined || rec.configHome === configHome);
  if (!sameReader) return true;
  const age = nowMs - Date.parse(rec.at);
  if (!Number.isFinite(age)) return true;
  return rec.result === 'error' ? age >= CONTROL_ERROR_RETRY_MS : age >= CONTROL_RESULT_MAX_AGE_MS;
}

/**
 * Pure judgement over the three probe transcripts. Two independent signals must agree: the load records (each source
 * listed when it should load, none listed under full job-mode settings), AND the input tokens (the full-settings probe
 * reads at least MIN_TOKEN_DROP fewer tokens than the exclusions-off probe, so the padded files really did not load,
 * not merely went unrecorded).
 */
export function judgeControl(probes: { off: Set<string>; claudeOnly: Set<string>; full: Set<string>; offTokens?: number | null; claudeOnlyTokens?: number | null; fullTokens?: number | null }): { result: ControlResult; detail: string } {
  const need = ['CLAUDE.md', '.claude/CLAUDE.md', 'memory'].filter(s => !probes.off.has(s));
  if (need.length) return { result: 'invisible', detail: `not visible with exclusions off: ${need.join(', ')}` };
  if (probes.off.has('AGENTS.md')) return { result: 'invisible', detail: 'AGENTS.md listed with exclusions off although CLAUDE.md exists: the record format is not as expected' };
  // The CLAUDE.md-only probe must list exactly the AGENTS.md fallback and the memory index, nothing it excluded.
  const co = [...probes.claudeOnly].sort().join(',');
  if (co !== ['AGENTS.md', 'memory'].sort().join(',')) return { result: 'invisible', detail: `CLAUDE.md-only probe listed {${co}}, expected exactly AGENTS.md and the memory index` };
  if (probes.full.size > 0) return { result: 'invisible', detail: `visible under full job-mode settings: ${[...probes.full].join(', ')}` };
  if (probes.offTokens == null || probes.fullTokens == null || probes.claudeOnlyTokens == null) return { result: 'invisible', detail: 'input token counts unavailable: cannot corroborate that excluded files did not load' };
  // Self-consistent per-file check within this run (all sentinels are the same size, f tokens each):
  //   off loads 3 files (CLAUDE.md, .claude/CLAUDE.md, memory index); claude-only loads 2 (AGENTS.md fallback, index);
  //   full loads 0. So off - claudeOnly = f (measured here), off - full = 3f, claudeOnly - full = 2f.
  // If one file loaded unrecorded under full settings, those become 2f and f: the ratios break by a whole file.
  const f = probes.offTokens - probes.claudeOnlyTokens;
  if (f < PER_FILE_MIN_TOKENS) return { result: 'invisible', detail: `measured per-file size ${f} tokens is below ${PER_FILE_MIN_TOKENS}: the padded files may not have loaded as expected` };
  if (f < EXPECTED_FILE_TOKENS * 0.75 || f > EXPECTED_FILE_TOKENS * 1.35) return { result: 'invisible', detail: `measured per-file size ${f} tokens is outside the expected band around ${EXPECTED_FILE_TOKENS}: other prompt content varied between probes, so the comparison is not trusted` };
  const d3 = probes.offTokens - probes.fullTokens; const d2 = probes.claudeOnlyTokens - probes.fullTokens;
  if (d3 > 3 * f / RATIO_TOLERANCE || d2 > 2 * f / RATIO_TOLERANCE) return { result: 'invisible', detail: `drops ${d3}/${d2} exceed 3f/2f (f=${f}) by more than the tolerance: other prompt content varied between probes, so the comparison is not trusted` };
  if (probes.offTokens - probes.fullTokens < 3 * f * RATIO_TOLERANCE) return { result: 'invisible', detail: `tokens off ${probes.offTokens}, full ${probes.fullTokens}: less than three files' worth (f=${f}), so a file may have loaded unrecorded` };
  if (probes.claudeOnlyTokens - probes.fullTokens < 2 * f * RATIO_TOLERANCE) return { result: 'invisible', detail: `tokens claude-only ${probes.claudeOnlyTokens}, full ${probes.fullTokens}: less than two files' worth (f=${f}), so a file may have loaded unrecorded under full settings` };
  return { result: 'visible', detail: `every source visible when loaded and absent when excluded; input tokens off ${probes.offTokens}, claude-only ${probes.claudeOnlyTokens}, full ${probes.fullTokens}` };
}

export class JobModePositiveControl {
  private readonly file: string;
  private inFlight: Promise<ControlRecord> | null = null;
  private inFlightVersion: string | null = null;
  /** The last result held in memory too, so the error back-off holds even if the cache file cannot be written. */
  private lastInMemory: ControlRecord | null = null;

  constructor(stateDir: string, private readonly deps: {
    claudeBinary: string;
    configHome: string;
    claudeVersion: () => Promise<string>;
    run?: (args: string[], cwd: string) => Promise<void>;
  }) {
    // One record per config home: the control result is valid only for the account (settings) it ran under.
    const home = crypto.createHash('sha256').update(path.resolve(deps.configHome)).digest('hex').slice(0, 16);
    this.file = path.join(stateDir, 'state', 'job-mode-checks', `_positive-control-${home}.json`);
  }

  readRecord(): ControlRecord | null {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as ControlRecord; } catch { return null; /* @silent-fallback-ok — no control has run yet */ }
  }

  /** The control result for the current Claude Code version, running it once if needed. */
  async ensure(): Promise<ControlRecord> {
    const version = await this.deps.claudeVersion();
    // The newer of the cached and in-memory records (the cache may be stale if its last write failed).
    const disk = this.readRecord(); const mem = this.lastInMemory;
    const rec = disk && mem ? (Date.parse(mem.at) >= Date.parse(disk.at) ? mem : disk) : (disk ?? mem);
    if (rec && !controlRerunDue(rec, version, path.resolve(this.deps.configHome), Date.now())) return rec;
    // An in-flight run for a DIFFERENT version is never shared: wait for it to finish, then decide again for this one.
    if (this.inFlight && this.inFlightVersion !== version) {
      await this.inFlight.catch(() => undefined); // @silent-fallback-ok — its outcome is re-read from the record below
      return this.ensure();
    }
    if (!this.inFlight) {
      this.inFlightVersion = version;
      /* @self-action-controller: job-mode-positive-control */
      this.inFlight = this.runControl(version).finally(() => { this.inFlight = null; this.inFlightVersion = null; });
    }
    return this.inFlight;
  }

  private async runOnce(root: string, settings: object | null, appendSystemPrompt?: string): Promise<string> {
    const sessionId = newJobModeSessionId();
    // No tools: the probe only needs Claude Code to load (or not load) the instruction files and reply once.
    const args = ['-p', 'Reply with the single word OK.', '--model', 'claude-haiku-5-5', '--max-turns', '1', '--tools', '', '--session-id', sessionId];
    if (settings) args.push('--settings', JSON.stringify(settings));
    // The full-settings probe also carries --append-system-prompt, the same flag pairing a real job-mode launch uses.
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
    const run = this.deps.run ?? (async (a: string[], cwd: string) => {
      await execFileAsync(this.deps.claudeBinary, a, { cwd, timeout: 120_000, env: { ...process.env, CLAUDE_CONFIG_DIR: this.deps.configHome } });
    });
    await run(args, root);
    const t = findClaudeTranscript(sessionId, root, [this.deps.configHome]);
    // A missing transcript, or one that never reached a model reply, proves nothing about what loaded:
    // it is an error (the control result is then not 'visible', so no job check can pass on it).
    if (!t) throw new Error('probe transcript missing');
    // The same bounded read as the job check (first 256 KB), so the control sees exactly the window a job check sees.
    const fd = fs.openSync(t, 'r');
    let text: string;
    try { const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, PROBE_READ_MAX_BYTES)); fs.readSync(fd, buf, 0, buf.length, 0); text = buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
    const hasReply = text.split('\n').some((l) => {
      try { const r = JSON.parse(l); return r?.type === 'assistant' || r?.message?.role === 'assistant' ? isRealModelReply(r) : false; } catch { return false; } // @silent-fallback-ok — a malformed line is not a reply
    });
    if (!hasReply) throw new Error('probe transcript has no model reply');
    const firstAssistant = text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }) // @silent-fallback-ok — malformed lines skipped
      .find((r) => r?.type === 'assistant' || r?.message?.role === 'assistant');
    if (!isRealModelReply(firstAssistant)) throw new Error('probe transcript: first assistant record is not a model reply');
    return text;
  }

  private async runControl(claudeVersion: string): Promise<ControlRecord> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobmode-control-')));
    const memDir = path.join(this.deps.configHome, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    const memoryIndex = path.join(memDir, 'MEMORY.md');
    let record: ControlRecord;
    try {
      const pad = (tag: string) => `${tag}\n` + Array.from({ length: Math.ceil(SENTINEL_PAD_CHARS / 48) }, (_, i) => `${tag} padding line ${i} for the token check.`).join('\n') + '\n';
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), pad('SENTINEL-CLAUDE-MD'));
      fs.writeFileSync(path.join(root, 'AGENTS.md'), pad('SENTINEL-AGENTS-MD'));
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(root, '.claude', 'CLAUDE.md'), pad('SENTINEL-DOT-CLAUDE'));
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(memoryIndex, pad('- SENTINEL-MEMORY'));
      const offText = await this.runOnce(root, null);
      const off = listedSources(offText, root, memoryIndex);
      const claudeOnlyText = await this.runOnce(root, { claudeMdExcludes: [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')] });
      const claudeOnly = listedSources(claudeOnlyText, root, memoryIndex);
      const fullText = await this.runOnce(root, {
        claudeMdExcludes: [path.join(root, 'CLAUDE.md'), path.join(root, 'AGENTS.md'), path.join(root, '.claude', 'CLAUDE.md')],
        autoMemoryEnabled: false,
      }, PROBE_APPENDED_PROMPT);
      const full = listedSources(fullText, root, memoryIndex);
      const j = judgeControl({ off, claudeOnly, full, offTokens: firstReplyInputTokens(offText), claudeOnlyTokens: firstReplyInputTokens(claudeOnlyText), fullTokens: firstReplyInputTokens(fullText) });
      // The probes must all have run on the version the result is labelled with: re-read it afterwards.
      const after = await this.deps.claudeVersion();
      if (after !== claudeVersion) throw new Error(`Claude Code version changed during the probes (${claudeVersion} -> ${after})`);
      record = { claudeVersion, ...j, at: new Date().toISOString(), configHome: path.resolve(this.deps.configHome) };
    } catch (err) {
      record = { claudeVersion, result: 'error', detail: String(err instanceof Error ? err.message : err).slice(0, 300), at: new Date().toISOString(), configHome: path.resolve(this.deps.configHome) };
    } finally {
      try { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-mode positive control: remove probe temp dir' }); } catch { /* @silent-fallback-ok — temp dir cleanup */ }
      try { SafeFsExecutor.safeRmSync(path.dirname(memDir), { recursive: true, force: true, operation: 'job-mode positive control: remove probe project dir' }); } catch { /* @silent-fallback-ok — probe project dir cleanup */ }
    }
    this.lastInMemory = record;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(record, null, 2));
    } catch (err) {
      // @silent-fallback-ok — the in-memory record still applies the back-off; the write failure is logged.
      console.warn(`[job-mode] positive-control record not written: ${err instanceof Error ? err.message : String(err)}`);
    }
    return record;
  }
}
