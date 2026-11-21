// Builds one deterministic fixture repo and a separate truth file the agents never see.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/private/tmp/claude-501/e2cm/template';
const TRUTH = '/private/tmp/claude-501/e2cm/harness/truth.json';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

let seed = 42;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const w = (rel, body) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const truth = {};
const owners = ['ana', 'bo', 'chen', 'dee'];

w('package.json', JSON.stringify({ name: 'fixture-service', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
w('README.md', '# fixture-service\n\nA small service used for maintenance work. Run tests with `npm test`.\n');

// Pagination bug (task 3)
w('src/lib/pagination.js', `// Pages are 1-based.\nexport function pageSlice(items, page, size) {\n  const start = page * size;\n  return items.slice(start, start + size);\n}\n\nexport function pageCount(total, size) {\n  return Math.ceil(total / size);\n}\n`);
w('tests/pagination.test.js', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { pageSlice, pageCount } from '../src/lib/pagination.js';\n\ntest('first page', () => assert.deepEqual(pageSlice([1,2,3,4,5], 1, 2), [1,2]));\ntest('last partial page', () => assert.deepEqual(pageSlice([1,2,3,4,5], 3, 2), [5]));\ntest('page count', () => assert.equal(pageCount(5, 2), 3));\n`);
w('src/lib/num.js', `export function roundTo(value, places) {\n  const f = 10 ** places;\n  return Math.round(value * f) / f;\n}\n`);
w('src/net/client.js', `export function legacyFetch(url) {\n  return 'GET ' + url;\n}\n`);

// Utilities (task 9)
const utilNames = [];
for (let u = 0; u < 6; u++) {
  const names = [0, 1, 2].map((i) => `util${'ABCDEF'[u]}${i}`);
  utilNames.push(...names.map((n) => ({ n, u })));
  w(`src/util/u${u}.js`, names.map((n, i) => `export function ${n}(x) {\n  return x + ${i};\n}\n`).join('\n'));
}
const used = new Set();
while (used.size < 11) used.add(pick(utilNames).n);
truth.dead = utilNames.map((x) => x.n).filter((n) => !used.has(n)).sort();
const usedList = [...used];

// Services (tasks 2, 6, 9)
for (let s = 0; s < 12; s++) {
  const mine = usedList.filter((_, i) => i % 12 === s || (s === 0 && i >= 12));
  const imports = mine.map((n) => { const u = utilNames.find((x) => x.n === n).u; return `import { ${n} } from '../util/u${u}.js';`; }).join('\n');
  const calls = 1 + (s % 3);
  const body = Array.from({ length: calls }, (_, i) => `  out.push(legacyFetch('/svc/${s}/${i}'));`).join('\n');
  const todo = s % 2 === 0 ? `  // TODO(${owners[s % 4]}): tidy service ${s}\n` : '';
  const extra = s === 3 ? `export const legacyFetchCount = ${calls};\n` : '';
  const use = mine.length ? `  out.push(String(${mine.map((n) => `${n}(1)`).join(' + ')}));\n` : '';
  w(`src/services/s${pad(s)}.js`, `import { legacyFetch } from '../net/client.js';\n${imports}${imports ? '\n' : ''}\n${extra}export function call${s}() {\n  const out = [];\n${todo}${body}\n${use}  return out;\n}\n`);
}
w('tests/services.test.js', `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${Array.from({ length: 12 }, (_, s) => `import { call${s} } from '../src/services/s${pad(s)}.js';`).join('\n')}\n\ntest('services call the client', () => {\n  for (const f of [${Array.from({ length: 12 }, (_, s) => `call${s}`).join(', ')}]) assert.match(f()[0], /^GET \\/svc\\//);\n});\n`);
w('docs/notes.md', `# Notes\n\nTODO(zed): this one is in docs and is not a source TODO.\nWe may remove ${truth.dead[0]} one day.\n`);

// Job handlers (tasks 6, 7)
truth.timeouts = {};
for (let j = 0; j < 14; j++) {
  const has = j % 3 === 0;
  const val = 5000 + j * 100;
  truth.timeouts[`job${pad(j)}`] = has ? val : 30000;
  const todo = j % 5 === 1 ? `// TODO(${owners[j % 4]}): review schedule\n` : '';
  w(`src/jobs/job${pad(j)}.js`, `${todo}export const config = {\n  name: 'job${pad(j)}',\n  cron: '${j} * * * *',\n${has ? `  timeoutMs: ${val},\n` : ''}};\n`);
}

// Routes and stale API doc (task 12)
const routes = [];
['users', 'jobs', 'topics', 'health'].forEach((r, i) => {
  const lines = [];
  const mk = (m, p) => { routes.push({ method: m.toUpperCase(), path: p }); lines.push(`router.${m}('${p}', handler);`); };
  mk('get', `/${r}`);
  if (i !== 3) { mk('post', `/${r}`); mk('get', `/${r}/:id`); }
  if (i === 1) mk('delete', `/${r}/:id`);
  w(`src/routes/${r}.js`, `const handler = () => {};\nexport function mount(router) {\n  ${lines.join('\n  ')}\n}\n`);
});
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
truth.routes = routes;
w('docs/API.md', `# API\n\n| Method | Path |\n| --- | --- |\n| GET | /users |\n| GET | /legacy |\n| POST | /jobs |\n`);

// Job registry (task 5)
const reg = [];
for (let i = 0; i < 30; i++) {
  const slug = `task-${pad(i)}`;
  const exists = i % 4 !== 2;
  if (exists) w(`scripts/${slug}.sh`, '#!/bin/sh\necho ok\n');
  reg.push({ slug, enabled: i % 3 !== 0, script: `scripts/${slug}.sh` });
}
w('state/jobs.json', JSON.stringify({ jobs: reg }, null, 2) + '\n');
truth.broken = reg.filter((x) => x.enabled && !fs.existsSync(path.join(ROOT, x.script))).map((x) => x.slug).sort();

// Server log + session map (tasks 1, 11)
const comps = ['router', 'db', 'scheduler', 'relay', 'auth'];
const codes = ['E101', 'E204', 'E310', 'E415', 'E522'];
const sessions = Array.from({ length: 40 }, (_, i) => `s${pad(i)}`);
const map = Object.fromEntries(sessions.map((s) => [s, 1000 + int(9)]));
w('data/sessions.json', JSON.stringify(map, null, 1) + '\n');
const log = []; const errCount = {}; const crashes = [];
let t = Date.UTC(2026, 10, 1, 0, 0, 0);
for (let i = 0; i < 6000; i++) {
  t += 500 + int(4000);
  const ts = new Date(t).toISOString();
  const s = pick(sessions);
  const x = rnd();
  if (i > 1200 && x < 0.004) { crashes.push({ s, t }); log.push(`${ts} FATAL [${pick(comps)}] session=${s} crash: worker exited`); continue; }
  if (x < 0.18) { const c = codes[Math.min(int(5), int(5))]; errCount[c] = (errCount[c] || 0) + 1; log.push(`${ts} ERROR [${pick(comps)}] code=${c} session=${s} request failed`); continue; }
  if (x < 0.42) { log.push(`${ts} WARN [${pick(comps)}] code=${codes[4 - Math.min(int(5), int(5))]} session=${s} slow request`); continue; }
  log.push(`${ts} INFO [${pick(comps)}] session=${s} ok`);
}
w('logs/server.log', log.join('\n') + '\n');
const top = Object.entries(errCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
truth.topError = { code: top[0], count: top[1] };
truth.incident = { firstSession: crashes[0].s, topic: map[crashes[0].s], crashedSessions: new Set(crashes.map((c) => c.s)).size };

// Usage ledger (task 4)
const usage = []; const totals = {};
for (let i = 0; i < 4000; i++) {
  if (i % 397 === 11) { usage.push('{"topic": 12, "input": BROKEN'); continue; }
  const topic = 2000 + Math.min(int(15), int(15));
  const input = int(9000); const output = int(3000); const cache = int(50000);
  totals[topic] = (totals[topic] || 0) + input + output;
  usage.push(JSON.stringify({ topic, input, output, cache }));
}
w('data/usage.jsonl', usage.join('\n') + '\n');
truth.top3 = Object.entries(totals).map(([k, v]) => ({ topic: Number(k), total: v })).sort((a, b) => b.total - a.total).slice(0, 3);

// Source TODOs (task 6)
const todos = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { const m = l.match(/TODO\((\w+)\)/); if (m) todos.push(`${path.relative(ROOT, p)},${i + 1},${m[1]}`); }); } };
walk(path.join(ROOT, 'src'));
truth.todos = todos.sort();

// Git history (task 8)
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' } }).trim();
git('init', '-q', '-b', 'main');
git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'initial import');
for (let c = 0; c < 12; c++) {
  fs.appendFileSync(path.join(ROOT, 'docs/CHANGELOG.md'), `- change ${c}\n`);
  if (c === 5) { fs.appendFileSync(path.join(ROOT, 'src/net/client.js'), '\nexport const MAGIC_RETRY_BUDGET = 7;\n'); }
  if (c === 9) { const p = path.join(ROOT, 'src/net/client.js'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('MAGIC_RETRY_BUDGET = 7', 'MAGIC_RETRY_BUDGET = 9')); }
  git('add', '-A'); git('commit', '-q', '--no-verify', '-m', `maintenance ${c}`);
  if (c === 5) truth.magicCommit = git('rev-parse', 'HEAD');
}
fs.writeFileSync(TRUTH, JSON.stringify(truth, null, 1));
console.log(JSON.stringify({ files: git('ls-files').split('\n').length, dead: truth.dead.length, broken: truth.broken.length, todos: truth.todos.length, routes: truth.routes.length, topError: truth.topError, incident: truth.incident, top3: truth.top3[0], magic: truth.magicCommit.slice(0, 8) }));
