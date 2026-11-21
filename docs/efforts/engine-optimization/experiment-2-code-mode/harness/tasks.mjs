import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const json = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const testsPass = (d) => { try { execFileSync('node', ['--test'], { cwd: d, stdio: 'pipe', timeout: 60000 }); return true; } catch { return false; } };
const servicesPass = (d) => { try { execFileSync('node', ['--test', 'tests/services.test.js'], { cwd: d, stdio: 'pipe', timeout: 60000 }); return true; } catch { return false; } };
const evalIn = (d, code) => execFileSync('node', ['--input-type=module', '-e', code], { cwd: d, encoding: 'utf8', timeout: 30000 }).trim();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

export const tasks = [
  { id: 'T01-log-triage', prompt: 'In logs/server.log, find the error code that appears most often on ERROR-level lines only (ignore WARN lines). Write out/top-error.json as {"code": "...", "count": N}.',
    check: (d, t) => eq(json(d, 'out/top-error.json'), t.topError) },
  { id: 'T02-rename', prompt: 'Rename the function legacyFetch to safeFetch everywhere in src/. Do not rename any other identifier, even one that contains that name. tests/services.test.js must still pass.',
    check: (d) => { const src = walk(path.join(d, 'src')).map((f) => fs.readFileSync(f, 'utf8')).join('\n'); return !/\blegacyFetch\b/.test(src) && /\bsafeFetch\b/.test(src) && /\blegacyFetchCount\b/.test(src) && servicesPass(d); } },
  { id: 'T03-fix-bug', prompt: 'The test suite has a failure. Find the cause and fix it in the source. Do not change any test file.',
    check: (d) => { const orig = fs.readFileSync('/private/tmp/claude-501/e2cm/template/tests/pagination.test.js', 'utf8'); return fs.readFileSync(path.join(d, 'tests/pagination.test.js'), 'utf8') === orig && testsPass(d) && evalIn(d, "import {pageSlice as p} from './src/lib/pagination.js';console.log(JSON.stringify(p([1,2,3,4,5,6],2,3)))") === '[4,5,6]'; } },
  { id: 'T04-usage-rollup', prompt: 'data/usage.jsonl has one JSON record per line, and some lines are malformed (skip those). For each topic, total = sum of input + output (not cache). Write out/top3.json as an array of the 3 highest topics, highest first, each {"topic": N, "total": N}.',
    check: (d, t) => eq(json(d, 'out/top3.json'), t.top3) },
  { id: 'T05-job-audit', prompt: 'state/jobs.json lists jobs. Find every job that is enabled and whose script file does not exist in this repo. Write out/broken.json as a sorted array of their slugs.',
    check: (d, t) => eq(json(d, 'out/broken.json'), t.broken) },
  { id: 'T06-todo-index', prompt: 'Find every TODO(owner) comment under src/ only. Write out/todos.csv with one line per TODO and no header, formatted path,line,owner, where path is relative to the repo root. Sort the lines as plain strings.',
    check: (d, t) => eq(fs.readFileSync(path.join(d, 'out/todos.csv'), 'utf8').trim().split('\n'), t.todos) },
  { id: 'T07-bulk-config', prompt: 'Every file in src/jobs/ exports a config object. Add timeoutMs: 30000 to each config that has no timeoutMs. Leave existing timeoutMs values unchanged.',
    check: (d, t) => Object.entries(t.timeouts).every(([n, v]) => Number(evalIn(d, `import {config as c} from './src/jobs/${n}.js';console.log(c.timeoutMs)`)) === v) },
  { id: 'T08-git-forensics', prompt: 'Using git history, find the commit that first introduced the constant MAGIC_RETRY_BUDGET (not the commit that later changed its value). Write its full SHA to out/commit.txt.',
    check: (d, t) => fs.readFileSync(path.join(d, 'out/commit.txt'), 'utf8').trim() === t.magicCommit },
  { id: 'T09-dead-exports', prompt: 'Find every function exported from src/util/ that is never imported by any other file in src/. A mention in a comment or in docs does not count as use. Write out/dead.json as a sorted array of the function names.',
    check: (d, t) => eq(json(d, 'out/dead.json'), t.dead) },
  { id: 'T10-add-feature', prompt: 'Add an exported function clamp(value, min, max) to src/lib/num.js. It returns value limited to the range, throws RangeError when min > max, and returns NaN when value is NaN. Add tests for it in tests/num.test.js. All tests must pass, except fix any existing failure you find too.',
    check: (d) => testsPass(d) && fs.existsSync(path.join(d, 'tests/num.test.js')) && evalIn(d, "import {clamp as c} from './src/lib/num.js';let r=false;try{c(1,5,2)}catch(e){r=e instanceof RangeError};console.log([c(5,1,3)===3,c(-1,0,2)===0,c(2,1,3)===2,Number.isNaN(c(NaN,0,1)),r].every(Boolean))") === 'true' },
  { id: 'T11-incident', prompt: 'logs/server.log contains FATAL crash lines. data/sessions.json maps each session to its topic. Write out/incident.json as {"firstSession": "...", "topic": N, "crashedSessions": N}: the session of the earliest crash, that session\'s topic, and how many distinct sessions crashed.',
    check: (d, t) => eq(json(d, 'out/incident.json'), t.incident) },
  { id: 'T12-doc-sync', prompt: 'docs/API.md has a table of routes that is out of date. Update the table so it lists exactly the routes defined in src/routes/, one row each as | METHOD | path | with the method in capitals, sorted by path and then by method. Keep the table header.',
    check: (d, t) => { const rows = fs.readFileSync(path.join(d, 'docs/API.md'), 'utf8').split('\n').map((l) => l.match(/^\|\s*([A-Z]+)\s*\|\s*(\/\S*)\s*\|/)).filter(Boolean).map((m) => ({ method: m[1], path: m[2] })); return eq(rows, t.routes); } },
];
