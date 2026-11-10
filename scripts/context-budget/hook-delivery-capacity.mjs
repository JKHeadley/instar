#!/usr/bin/env node
/**
 * hook-delivery-capacity — Phase 0 "delivery capacity" probe for
 * docs/specs/context-budget-layered-summaries.md (§9.2 rung 1, §16 item 1;
 * check 4 of docs/specs/reports/context-budget-phase0-results.md).
 *
 * Question: does a SessionStart hook's stdout of a given size reach the model
 * intact? This is the carrier of the fold ladder's first rung (clear-and-seed)
 * and of the post-compaction recovery block.
 *
 * Method: a throwaway project under $TMPDIR (never the agent home or a repo)
 * whose project settings carry ONE SessionStart(startup) hook that prints a
 * payload of about --chars characters: a FIRST codeword line, filler lines of
 * distinct pseudo-random words, a MIDDLE codeword line at the halfway point,
 * more filler, and a LAST codeword line. One headless `claude -p` turn, tools
 * off, asks for the three codewords. Recorded per size: the payload size, the
 * size of the hook attachment the transcript stored, the model's answer, which
 * codewords it returned, and the turn's real input usage (cache read + write +
 * uncached), which is the token size of what was delivered.
 *
 * It RUNS A REAL SESSION per size (subscription or key, whatever the inherited
 * CLAUDE_CONFIG_DIR / auth provides). Keep sizes few. Writes only under $TMPDIR
 * and the engine's own transcript directory.
 *
 * Usage: node scripts/context-budget/hook-delivery-capacity.mjs --chars 200000 [--chars ...] [--json] [--model haiku] [--claude claude]
 *   --json  deliver through hookSpecificOutput.additionalContext instead of plain stdout
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const sizes = args.flatMap((a, i) => (a === '--chars' ? [Number(args[i + 1])] : []));
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : null;
const claudeBin = args.includes('--claude') ? args[args.indexOf('--claude') + 1] : 'claude';
/** --json: the hook prints {hookSpecificOutput:{hookEventName:'SessionStart',additionalContext}} instead of plain stdout. */
const jsonMode = args.includes('--json');
if (!sizes.length) { console.error('give at least one --chars N'); process.exit(2); }

const WORDS = 'amber basil cedar delta ember fable garnet harbor indigo juniper kestrel lumen maple nectar onyx pewter quartz russet sable tundra umber vellum willow xenon yarrow zephyr'.split(' ');
const code = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function payload(chars, cw) {
  const lines = [`FIRST-CODEWORD: ${cw.first}`];
  let n = lines[0].length + 1; let i = 0; let placedMiddle = false;
  while (n < chars - 40) {
    if (!placedMiddle && n >= chars / 2) { const m = `MIDDLE-CODEWORD: ${cw.middle}`; lines.push(m); n += m.length + 1; placedMiddle = true; continue; }
    const r = crypto.createHash('sha256').update(String(i++)).digest();
    const l = `${String(i).padStart(6, '0')} ${WORDS[r[0] % 26]} ${WORDS[r[1] % 26]} ${WORDS[r[2] % 26]} ${r.readUInt16BE(3)}`;
    lines.push(l); n += l.length + 1;
  }
  lines.push(`LAST-CODEWORD: ${cw.last}`);
  return `${lines.join('\n')}\n`;
}

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cb-delivery-'));
const results = [];
for (const chars of sizes) {
  const proj = path.join(root, `p${chars}`);
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const cw = { first: code('FIRST'), middle: code('MID'), last: code('LAST') };
  const file = path.join(proj, 'payload.txt');
  const body = payload(chars, cw);
  fs.writeFileSync(file, jsonMode ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: body } }) : body);
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: `cat '${file}'`, timeout: 60 }] }] } }, null, 2));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID') delete env[k];
  if (!env.ANTHROPIC_API_KEY) delete env.ANTHROPIC_API_KEY;
  if (!env.ANTHROPIC_BASE_URL) delete env.ANTHROPIC_BASE_URL;
  const sid = crypto.randomUUID();
  const q = 'Session-start context was provided to you. Report the FIRST, MIDDLE and LAST codewords you can see in it, exactly, as three lines "FIRST: x", "MIDDLE: x", "LAST: x"; write NONE for any you cannot see. Nothing else.';
  const argv = ['-p', '--session-id', sid, '--setting-sources', 'project', '--disallowedTools=Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Read,Grep,Glob', ...(model ? ['--model', model] : []), q];
  const t0 = Date.now();
  const r = spawnSync(claudeBin, argv, { cwd: proj, env, encoding: 'utf-8', timeout: 600_000, input: '' });
  const answer = (r.stdout ?? '').trim();
  // Find the transcript and read the hook attachment and the usage.
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const tdir = path.join(cfg, 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'));
  const tfile = path.join(tdir, `${sid}.jsonl`);
  let stored = null; let usage = null; let attachmentKind = null;
  if (fs.existsSync(tfile)) {
    for (const line of fs.readFileSync(tfile, 'utf-8').split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const a = e.attachment;
      if (e.type === 'attachment' && a && typeof a.hookName === 'string' && a.hookName.startsWith('SessionStart')) {
        attachmentKind = a.type; stored = Math.max(stored ?? 0, typeof a.content === 'string' ? a.content.length : 0, typeof a.stdout === 'string' ? a.stdout.length : 0);
      }
      if (e.type === 'assistant' && e.message?.usage && !usage) usage = e.message.usage;
    }
  }
  const got = (k) => answer.includes(cw[k]);
  results.push({
    chars, mode: jsonMode ? 'additionalContext-json' : 'plain-stdout', payloadBytes: fs.statSync(file).size, exit: r.status, durationMs: Date.now() - t0, model: model ?? 'default',
    transcript: fs.existsSync(tfile) ? tfile.replace(os.homedir(), '~') : null, hookAttachment: attachmentKind, storedChars: stored,
    inputTokens: usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : null,
    sawFirst: got('first'), sawMiddle: got('middle'), sawLast: got('last'),
    answer: answer.slice(0, 300), stderr: (r.stderr ?? '').slice(0, 300),
  });
}
console.log(JSON.stringify({ machine: os.hostname(), at: new Date().toISOString(), claudeVersion: spawnSync(claudeBin, ['--version'], { encoding: 'utf-8' }).stdout.trim(), workDir: root, results }, null, 2));
