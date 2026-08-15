#!/usr/bin/env node
// rank-improvements.mjs — INSTAR-Bench v2 stage 3: build the RANKED
// prompt-improvement queue from judged forensic verdicts (spec §4/§5).
//
// Input:  <run>/forensic-verdicts.jsonl — one line per judged forensic group:
//   { task, caseId, model, promptFault: 'model-limit'|'prompt-improvable'|
//     'context-missing'|'case-defect', rationale, proposedEdit? }
//   (proposedEdit: { file, summary, editedPrompt? } — required when
//    promptFault is prompt-improvable/context-missing and the group is ranked)
// Also reads <run>/forensic-queue.json for the priority signals.
//
// Output: <run>/prompt-improvement-queue.json — PER COMPONENT (one prompt
// serves many cases): every prompt-improvable/context-missing verdict for a
// component is folded into ONE queue entry carrying all its evidence cases,
// ranked by criticality × cross-model share × case count. case-defect
// verdicts are routed to a separate caseFixes list (the bench fixes ITSELF,
// never the production prompt). model-limit verdicts feed the routing table,
// not the prompt queue.
//
// Usage: node rank-improvements.mjs --run <stamp>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RUN = arg('run', null);
if (!RUN) { console.error('--run <stamp> required'); process.exit(4); }
const RUNDIR = join(HERE, '..', 'results', 'instar-bench-v2', RUN);
const VERDICTS = join(RUNDIR, 'forensic-verdicts.jsonl');
const QUEUE = join(RUNDIR, 'forensic-queue.json');
if (!existsSync(VERDICTS) || !existsSync(QUEUE)) { console.error('need forensic-queue.json + forensic-verdicts.jsonl — run forensics.mjs then judge the queue'); process.exit(4); }

const verdicts = readFileSync(VERDICTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const queue = JSON.parse(readFileSync(QUEUE, 'utf8'));
const qByKey = new Map(queue.map((q) => [`${q.task}::${q.caseId}::${q.model}`, q]));

const VALID = new Set(['model-limit', 'prompt-improvable', 'context-missing', 'case-defect']);
const components = new Map();
const caseFixes = [];
const modelLimits = [];
let unmatched = 0;

for (const v of verdicts) {
  if (!VALID.has(v.promptFault)) { console.error(`skipping invalid promptFault ${v.promptFault} (${v.task}::${v.caseId}::${v.model})`); continue; }
  const q = qByKey.get(`${v.task}::${v.caseId}::${v.model}`);
  if (!q) { unmatched++; continue; }
  if (v.promptFault === 'case-defect') { caseFixes.push({ task: v.task, caseId: v.caseId, rationale: v.rationale }); continue; }
  if (v.promptFault === 'model-limit') { modelLimits.push({ task: v.task, caseId: v.caseId, model: v.model, rationale: v.rationale }); continue; }
  const c = components.get(q.component) ?? components.set(q.component, {
    component: q.component, task: q.task, nature: q.nature, critical: !!q.critical,
    kinds: new Set(), cases: [], maxCrossModelShare: 0, proposedEdits: [],
  }).get(q.component);
  c.kinds.add(v.promptFault);
  c.cases.push({ caseId: v.caseId, axis: q.axis, model: v.model, dominantClass: q.dominantClass, crossModelShare: q.crossModelShare, rationale: v.rationale });
  c.maxCrossModelShare = Math.max(c.maxCrossModelShare, q.crossModelShare ?? 0);
  if (v.proposedEdit) c.proposedEdits.push({ ...v.proposedEdit, evidenceCase: v.caseId, evidenceModel: v.model });
}

const ranked = [...components.values()].map((c) => ({
  ...c,
  kinds: [...c.kinds],
  distinctCases: new Set(c.cases.map((x) => x.caseId)).size,
  // criticality × strongest cross-model signal × breadth of evidence
  rank: Number(((c.critical ? 2 : 1) * (0.5 + c.maxCrossModelShare) * Math.log2(1 + new Set(c.cases.map((x) => x.caseId)).size)).toFixed(2)),
})).sort((a, b) => b.rank - a.rank);

writeFileSync(join(RUNDIR, 'prompt-improvement-queue.json'), JSON.stringify({
  run: RUN, generatedFrom: { verdicts: verdicts.length, groups: queue.length, unmatched },
  queue: ranked, caseFixes, modelLimits,
}, null, 1));
console.error(`[rank] ${ranked.length} component entries (${caseFixes.length} case fixes, ${modelLimits.length} model-limit records) → prompt-improvement-queue.json`);
console.log(JSON.stringify({ run: RUN, components: ranked.length, caseFixes: caseFixes.length, modelLimits: modelLimits.length, unmatched }));
