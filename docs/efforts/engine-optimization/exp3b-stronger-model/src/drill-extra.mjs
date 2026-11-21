// Supplementary crash drill: T10 with the crash on the FIRST shell action (the stronger model
// writes all three files with one shell command, so the planned write_file:2 crash never fires).
// Usage: node drill-extra.mjs <runDir> <repeats>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TASKS } from './tasks.mjs';
const RUN = path.resolve(process.argv[2]); const N = Number(process.argv[3] || 3);
const ENGINE = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'engine.mjs');
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const t = TASKS.find((x) => x.id === 'T10-manifest'); const out = [];
for (let i = 1; i <= N; i++) {
  const group = path.join(RUN, `extra-${i}`); fs.rmSync(group, { recursive: true, force: true });
  const ws = path.join(group, 'ws', t.id); const state = path.join(group, 'state', t.id);
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(state, { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: ws });
  const wsr = fs.realpathSync(ws); const meta = t.setup(wsr);
  const env = { ...process.env, E3_OUTBOX: path.join(group, 'outbox.jsonl') };
  const r1 = spawnSync('node', [ENGINE, '--task', t.id, '--ws', wsr, '--state', state], { env: { ...env, CRASH_AT: 'bash:1' }, encoding: 'utf8', timeout: 900000, cwd: path.dirname(ENGINE) });
  const crashed = r1.signal === 'SIGKILL' || fs.existsSync(path.join(state, 'crash.jsonl'));
  const r2 = spawnSync('node', [ENGINE, '--task', t.id, '--ws', wsr, '--state', state, '--resume'], { env, encoding: 'utf8', timeout: 900000, cwd: path.dirname(ENGINE) });
  const ob = readJsonl(path.join(group, 'outbox.jsonl')); const groups = {};
  for (const m of ob) { const k = m.channel + '|' + m.text.trim(); groups[k] = (groups[k] || 0) + 1; }
  const effects = readJsonl(path.join(state, 'effects.jsonl')); const byKey = {};
  for (const e of effects.filter((e) => e.ran)) byKey[e.key] = (byKey[e.key] || 0) + 1;
  const chk = t.check(wsr, meta, ob, { sent: [], deleted: [] });
  out.push({ repeat: i, crashAt: 'bash:1', crashed, resumeExit: r2.status, dupMessages: Object.values(groups).reduce((a, n) => a + n - 1, 0), dupEffects: Object.values(byKey).reduce((a, n) => a + n - 1, 0), dedups: effects.filter((e) => !e.ran).map((e) => e.dedup), resumeNote: readJsonl(path.join(state, 'resume.jsonl')), completedAfterResume: chk.ok, got: chk.got });
  console.log(JSON.stringify(out[out.length - 1]).slice(0, 400));
}
fs.writeFileSync(path.join(RUN, 'drill-extra.json'), JSON.stringify(out, null, 2));
