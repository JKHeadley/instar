// reduce-judge.mjs — build a right-sized BLIND judge packet for in-session Fable-5 scoring.
// From the merged raw, pick a curated model set × all judge tasks × 1 representative
// sample (the first OK, non-empty one). Emit judge-blind-reduced.json (no model) +
// judge-key-reduced.json (anonId -> model, kept OUT of my scoring view).
// Usage: node reduce-judge.mjs <merged-stamp>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const stamp = process.argv[2];
const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks;
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
const judgeTaskIds = tasks.filter((t) => t.scoring === 'judge').map((t) => t.id);

// Curated set spanning the quality/speed/cost space — the models we'd actually route between.
const CURATED = new Set([
  'or-claude-opus-48', 'or-gpt-55', 'or-claude-sonnet-5', 'or-gpt-54', 'or-claude-haiku-45',
  'or-gpt-54-mini', 'or-gemini-31-flash-lite', 'or-gemini-35-flash', 'or-gemini-31-pro-preview',
  'or-qwen37-max', 'or-deepseek-v4-pro', 'or-glm-52', 'or-llama-4-scout', 'or-kimi-k26',
  'groq-llama4-scout',
]);

// Read the merged judge packet (aggregator output): {anonId, taskId, rubric, output, _model}.
const packet = JSON.parse(readFileSync(join(HERE, '..', 'results', 'instar-bench', stamp, 'judge-packet.json'), 'utf8'));

// pick first non-empty output per (pathway, judgeTask)
const pick = {};
for (const p of packet) {
  const r = { pathway: p._model, task: p.taskId, output: p.output };
  if (!CURATED.has(r.pathway) || !judgeTaskIds.includes(r.task)) continue;
  const key = `${r.pathway}|${r.task}`;
  if (pick[key]) continue;
  if (r.output && String(r.output).trim().length > 3) pick[key] = r;
}
// also keep a placeholder (empty) for missing cells so the gap is visible
const entries = [];
for (const pw of CURATED) for (const t of judgeTaskIds) {
  const r = pick[`${pw}|${t}`];
  entries.push({ pathway: pw, task: t, output: r ? r.output : '(no successful output)' });
}
// deterministic shuffle
const salt = entries.length;
const shuf = entries.map((e, i) => ({ e, k: (i * 2654435761 + salt * 40503) % 100000 }))
  .sort((a, b) => a.k - b.k)
  .map(({ e }, i) => ({ anonId: `J${String(i).padStart(3, '0')}`, ...e }));
const blind = shuf.map((x) => ({ anonId: x.anonId, task: x.task, rubric: taskById[x.task].rubric, output: x.output }));
const key = shuf.map((x) => ({ anonId: x.anonId, pathway: x.pathway, task: x.task }));
const OUT = join(HERE, '..', 'results', 'instar-bench', stamp);
writeFileSync(join(OUT, 'judge-blind-reduced.json'), JSON.stringify(blind, null, 1));
writeFileSync(join(OUT, 'judge-key-reduced.json'), JSON.stringify(key, null, 1));
console.log(JSON.stringify({ models: CURATED.size, judgeTasks: judgeTaskIds.length, cells: blind.length, out: OUT }));
