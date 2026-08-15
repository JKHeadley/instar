#!/usr/bin/env node
// LLM Pathway Benchmark Harness (dependency-free, node builtins only).
// Invokes each pathway (framework x model x mode) N times with a concurrency
// cap, capturing per-call latency, exit code, output bytes, parsed tokens, and
// a classified error signature. Writes one JSONL row per call + a summary JSON.
//
// Usage:
//   node harness.mjs --pathway <id|all> --prompt <name|file> --n <N> \
//        --concurrency <C> --timeout <ms> --label <run-label>
//
// Examples:
//   node harness.mjs --pathway claude-haiku --prompt ping --n 1        # smoke
//   node harness.mjs --pathway all --prompt ping --n 30 --concurrency 1  # baseline
//   node harness.mjs --pathway codex-gpt55 --prompt ping --n 20 --concurrency 8  # load
//
// Design notes:
// - Real calls only (Testing-Integrity standard). No mocks.
// - Every failure is captured (stderr + exit + classified signature), never swallowed.
// - Latency = wall-clock spawn->exit. Percentiles computed over OK calls only,
//   with error-rate reported separately.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const REG = JSON.parse(readFileSync(join(__dir, 'pathways.json'), 'utf8'));
const PROJECT_CWD = REG.cwd || process.cwd();
// Use a clean temp directory for CLI invocations to avoid loading project context (CLAUDE.md, etc.).
// This isolates the pathway measurement from project-specific context overhead.
const CLEAN_CWD = mkdtempSync(join(tmpdir(), 'llm-pathway-bench-'));

// ---- built-in prompt suite (synthetic). Real-component prompts live in prompts/*.txt ----
const PROMPTS = {
  ping:  'Reply with exactly the single word PONG and nothing else. Do not use any tools.',
  short: 'In one sentence, what is the capital of France? Answer directly, no tools.',
  json:  'Output exactly this JSON and nothing else: {"ok":true,"n":42}. No tools, no prose.',
};

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function resolvePrompt(nameOrFile) {
  if (PROMPTS[nameOrFile]) return { name: nameOrFile, text: PROMPTS[nameOrFile] };
  const p = resolve(nameOrFile);
  if (existsSync(p)) return { name: nameOrFile.replace(/[^a-z0-9]+/gi, '-'), text: readFileSync(p, 'utf8') };
  throw new Error('unknown prompt (not a builtin name or a readable file): ' + nameOrFile);
}

// ---- per-framework invocation construction ----
function buildInvocation(pw, promptText) {
  const { framework, bin, model, mode } = pw;
  switch (framework) {
    case 'claude':
      // Mirror instar's production ClaudeCliIntelligenceProvider invocation so the
      // measurement reflects the pathway AS INSTAR USES IT:
      //   claude -p <prompt> --model <model> --max-turns 1 --output-format json --setting-sources user
      // Two independent guards keep the ~83k project-CLAUDE.md bleed out of the
      // number: (1) we always spawn from CLEAN_CWD (no project CLAUDE.md on disk),
      // and (2) --setting-sources user (instar's own guard). Verified 2026-07-01:
      // clean-CWD alone → ~23.5k total input; instar-exact (project cwd + the flag)
      // → ~27.9k; the un-guarded repo-root call → ~83k input + >120s wall.
      return {
        cmd: bin,
        args: ['-p', promptText, '--model', model, '--max-turns', '1',
               '--output-format', 'json', '--setting-sources', 'user'],
        stdin: null,
      };
    case 'codex':
      // Mirror instar's production codex one-shot invocation:
      //   codex exec [--json] --skip-git-repo-check -s read-only -C <clean-cwd> -m <model> <prompt>
      // --skip-git-repo-check is REQUIRED to run in the clean scratch dir (codex
      // refuses an untrusted, non-git cwd otherwise). -C CLEAN_CWD keeps the repo's
      // ~26KB AGENTS.md + .codex/hooks.json out of the measurement (instar uses a
      // mkdtemp scratch dir for exactly this). Codex reads stdin even with a
      // positional prompt, so runOnce always closes stdin (else it hangs).
      return {
        cmd: bin,
        args: ['exec', ...(mode === 'exec-json' ? ['--json'] : []), '--skip-git-repo-check', '-s', 'read-only', '-C', CLEAN_CWD, '-m', model, promptText],
        stdin: null,
      };
    case 'pi':
      // pi --model <provider/id> --mode json <message>
      // --mode json surfaces per-call token usage AND cost in the JSONL events
      // (parseTokens reads the final message_end usage). pi's fixed token
      // overhead is tiny (~1k) vs claude-code (~23k) — no heavy harness prompt.
      return { cmd: bin, args: ['--model', model, '--mode', 'json', promptText], stdin: null };
    case 'gemini':
      // gemini -m <model> -o json --yolo -p <prompt>
      // -o json surfaces stats.models.<model>.tokens (input/prompt/candidates/
      // cached/total). --yolo = auto-approve tools; -p = prompt.
      return { cmd: bin, args: ['-m', model, '-o', 'json', '--yolo', '-p', promptText], stdin: null };
    case 'funnel': {
      // Metered-key path (budget-guard spec Layer 3): EVERY call goes through
      // metered-funnel.mjs — the harness never touches key material, and the
      // fail-closed budget gate rides in front of each benchmark call. Adds
      // ~80ms node-startup overhead, identical across models (noted in findings).
      const funnel = join(__dir, 'metered-funnel.mjs');
      const pf = join(CLEAN_CWD, 'funnel-prompt.txt');
      writeFileSync(pf, promptText); // same content for every call in a run
      return {
        cmd: process.execPath,
        args: [funnel, 'call', '--key', pw.key, '--model', model,
               '--prompt-file', pf, '--max-tokens', String(pw.maxTokens ?? 256),
               '--label', `bench-${pw.id}`, '--timeout', String(pw.callTimeoutMs ?? 90000)],
        stdin: null,
      };
    }
    default:
      throw new Error('unknown framework: ' + framework);
  }
}

// ---- error classification from exit + stderr (the failure taxonomy seed) ----
function classifyError(exitCode, stderr, stdout, timedOut) {
  if (timedOut) return 'timeout';
  const s = (stderr + '\n' + stdout).toLowerCase();
  if (/rate.?limit|429|too many requests|quota|usage limit|resets? (in|at)/.test(s)) return 'rate-limit';
  if (/usage policy|content policy|refus|cannot assist/.test(s)) return 'policy';
  if (/unauthor|invalid api key|not logged in|auth|credential|401|403/.test(s)) return 'auth';
  if (/enoent|command not found|no such file/.test(s)) return 'binary-missing';
  if (/model|not found|unknown model|invalid model|unsupported/.test(s)) return 'model-error';
  if (exitCode !== 0) return 'cli-error';
  return 'empty-output';
}

// ---- token parsing per framework (best-effort; captures what each mode surfaces) ----
function parseTokens(pw, stdout) {
  try {
    if (pw.framework === 'funnel') {
      // metered-funnel.mjs emits one JSON object with authoritative fields.
      const j = JSON.parse(stdout);
      return {
        tokensIn: j.tokensIn ?? null,
        tokensOut: j.tokensOut ?? null,
        tokensCached: null,
        costUsd: typeof j.costUsd === 'number' ? j.costUsd : null,
      };
    }
    if (pw.framework === 'claude') {
      const j = JSON.parse(stdout);
      const u = j.usage || {};
      return {
        tokensIn: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        tokensOut: u.output_tokens || 0,
        tokensCached: u.cache_read_input_tokens || 0,
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      };
    }
    if (pw.framework === 'codex' && pw.mode === 'exec-json') {
      // JSONL events; find token usage in any event carrying token counts
      let tin = 0, tout = 0;
      for (const line of stdout.split('\n')) {
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        const u = ev.usage || ev.token_usage || (ev.msg && ev.msg.usage) || null;
        if (u) { tin = u.input_tokens ?? u.prompt_tokens ?? tin; tout = u.output_tokens ?? u.completion_tokens ?? tout; }
      }
      return { tokensIn: tin, tokensOut: tout, tokensCached: 0, costUsd: null };
    }
    if (pw.framework === 'pi') {
      // pi --mode json emits JSONL events; the final usage (with a nonzero
      // totalTokens) rides message_end/turn_end/agent_end. pi surfaces cost too.
      let last = null;
      for (const line of stdout.split('\n')) {
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        const u = ev?.message?.usage || ev?.assistantMessageEvent?.partial?.usage || null;
        if (u && (u.totalTokens ?? 0) > 0) last = u;
      }
      if (last) return {
        tokensIn: last.input ?? 0,
        tokensOut: last.output ?? 0,
        tokensCached: last.cacheRead ?? 0,
        costUsd: typeof last.cost?.total === 'number' ? last.cost.total : null,
      };
    }
    if (pw.framework === 'gemini') {
      // gemini -o json → { session_id, response, stats.models.<model>.tokens }.
      // tokens: { input(=non-cached), prompt(=full input), candidates(=output),
      // total, cached, thoughts(=reasoning) }.
      const j = JSON.parse(stdout);
      const models = j?.stats?.models || {};
      const first = Object.values(models)[0];
      const tk = first?.tokens;
      if (tk) return {
        tokensIn: tk.prompt ?? tk.input ?? 0,
        tokensOut: tk.candidates ?? 0,
        tokensCached: tk.cached ?? 0,
        costUsd: null,
      };
    }
  } catch { /* fall through */ }
  return { tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null };
}

function runOnce(pw, prompt, timeoutMs) {
  return new Promise((res) => {
    const { cmd, args, stdin } = buildInvocation(pw, prompt.text);
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let child;
    // Merge per-pathway env overrides (e.g. CLAUDE_CONFIG_DIR for account isolation)
    const env = { ...process.env };
    if (pw.env) {
      for (const [k, v] of Object.entries(pw.env)) {
        env[k] = v.startsWith('~') ? v.replace(/^~/, process.env.HOME) : v;
      }
    }
    try {
      // Always spawn from CLEAN_CWD to avoid loading project context.
      // detached:true makes the child a PROCESS GROUP LEADER so a timeout can
      // kill the WHOLE tree. This is load-bearing for codex: `codex exec` forks
      // a native vendor grandchild; killing only the direct node wrapper orphans
      // the grandchild, which keeps the stdout pipe open so 'close' never fires
      // and the harness hangs forever on a wedged call (observed 5+ min past a
      // 120s cap). Killing the group (process.kill(-pid)) reaps the grandchild.
      child = spawn(cmd, args, { cwd: CLEAN_CWD, env, detached: true });
    } catch (e) {
      return res({ ok: false, latencyMs: 0, exitCode: null, errorSig: 'spawn-throw',
        stderrTail: String(e.message).slice(0, 300), stdoutBytes: 0, tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null });
    }
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Guarantee settlement: if the orphaned grandchild still holds the pipe so
      // 'close' never fires, force-finish after a short grace so the run proceeds.
      setTimeout(() => finish(null), 2000);
    }, timeoutMs);
    // ALWAYS close stdin. Codex (and pi) read stdin even when the prompt is a
    // positional arg — leaving it open hangs the child until the timeout. Write
    // any explicit stdin first, then end unconditionally.
    try { if (stdin) child.stdin.write(stdin); child.stdin.end(); } catch { /* stdin may already be closed */ }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const finish = (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const latencyMs = Date.now() - t0;
      const ok = !timedOut && exitCode === 0 && stdout.trim().length > 0;
      const errorSig = ok ? null : classifyError(exitCode, stderr, stdout, timedOut);
      const tok = ok ? parseTokens(pw, stdout) : { tokensIn: null, tokensOut: null, tokensCached: null, costUsd: null };
      res({ ok, latencyMs, exitCode, timedOut, errorSig,
        stdoutBytes: Buffer.byteLength(stdout), stderrTail: stderr.slice(-400), ...tok });
    };
    child.on('close', finish);
    child.on('error', (e) => { stderr += '\n[spawn-error] ' + e.message; finish(child.exitCode ?? null); });
  });
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function summarize(pwId, model, promptName, concurrency, records) {
  const okLat = records.filter(r => r.ok).map(r => r.latencyMs).sort((a, b) => a - b);
  const byError = {};
  for (const r of records) if (!r.ok) byError[r.errorSig] = (byError[r.errorSig] || 0) + 1;
  const okTokIn = records.filter(r => r.ok && r.tokensIn != null).map(r => r.tokensIn);
  const okTokOut = records.filter(r => r.ok && r.tokensOut != null).map(r => r.tokensOut);
  const avg = (a) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  return {
    pathway: pwId, model, promptName, concurrency,
    n: records.length, ok: okLat.length, errors: records.length - okLat.length,
    okRate: records.length ? +(okLat.length / records.length).toFixed(3) : 0,
    latencyMs: { p50: pct(okLat, 50), p95: pct(okLat, 95), p99: pct(okLat, 99), min: okLat[0] ?? null, max: okLat[okLat.length - 1] ?? null, mean: avg(okLat) },
    tokens: { meanIn: avg(okTokIn), meanOut: avg(okTokOut) },
    byError,
  };
}

async function main() {
  const which = argOf('pathway', 'all');
  const prompt = resolvePrompt(argOf('prompt', 'ping'));
  const N = parseInt(argOf('n', '1'), 10);
  const C = parseInt(argOf('concurrency', '1'), 10);
  const timeoutMs = parseInt(argOf('timeout', '60000'), 10);
  const label = argOf('label', 'run');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(__dir, 'results');
  mkdirSync(outDir, { recursive: true });

  process.stderr.write(`[bench] isolation: invoking from clean temp dir: ${CLEAN_CWD}\n`);

  const pathways = which === 'all' ? REG.pathways : REG.pathways.filter(p => p.id === which);
  if (!pathways.length) { console.error('no matching pathway:', which); process.exit(2); }

  const rawFile = join(outDir, `${stamp}_${label}_${which}_${prompt.name}_n${N}_c${C}.jsonl`);
  const summaries = [];
  for (const pw of pathways) {
    process.stderr.write(`\n[bench] ${pw.id} (${pw.model}, ${pw.mode}) x${N} c=${C} prompt=${prompt.name} ...\n`);
    const tasks = Array.from({ length: N }, (_, i) => i);
    const records = await pool(tasks, C, async (i) => {
      const r = await runOnce(pw, prompt, timeoutMs);
      const row = { ts: Date.now(), pathway: pw.id, framework: pw.framework, model: pw.model, mode: pw.mode,
        promptName: prompt.name, concurrency: C, iter: i, ...r };
      appendFileSync(rawFile, JSON.stringify(row) + '\n');
      process.stderr.write(`  #${i} ${r.ok ? 'OK' : 'FAIL(' + r.errorSig + ')'} ${r.latencyMs}ms${r.tokensOut != null ? ' out=' + r.tokensOut : ''}\n`);
      return r;
    });
    const sum = summarize(pw.id, pw.model, prompt.name, C, records);
    summaries.push(sum);
    process.stderr.write(`  => okRate=${sum.okRate} p50=${sum.latencyMs.p50}ms p95=${sum.latencyMs.p95}ms errors=${JSON.stringify(sum.byError)}\n`);
  }
  const sumFile = join(outDir, `${stamp}_${label}_${which}_${prompt.name}_n${N}_c${C}.summary.json`);
  writeFileSync(sumFile, JSON.stringify({ stamp, label, prompt: prompt.name, N, concurrency: C, timeoutMs, summaries }, null, 2));
  process.stdout.write('\n' + JSON.stringify({ rawFile, sumFile, summaries }, null, 2) + '\n');
}

main().catch((e) => { console.error('[bench] fatal:', e); process.exit(1); });
