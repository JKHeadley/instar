// score.mjs — pure deterministic scoring for INSTAR-Bench (no I/O, unit-tested).
// The judge families (agent/background) are scored separately by judge.mjs (Fable 5).
// Spec: docs/planning/2026-07-01-instar-bench-v1-spec.md.

/** Strip a leading/trailing code fence and surrounding whitespace. */
export function stripFence(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/** Extract the first balanced {...} JSON object from arbitrary model text. null if none. */
export function extractJson(s) {
  const t = stripFence(s);
  // Fast path: whole string is JSON.
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch { /* scan */ }
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Did the model wrap the required output in extra prose? (format-discipline penalty) */
export function hasChatter(raw, jsonObj) {
  if (jsonObj == null) return true;
  const t = stripFence(raw);
  // Clean = the stripped output IS essentially just the JSON (allow trailing newline).
  const compact = t.replace(/\s+/g, '');
  const jsonCompact = JSON.stringify(jsonObj).replace(/\s+/g, '');
  // Tolerate key-order differences: compare lengths within a small margin.
  return Math.abs(compact.length - jsonCompact.length) > Math.max(8, jsonCompact.length * 0.15);
}

function normVal(v) { return typeof v === 'string' ? v.trim().toLowerCase() : v; }

/**
 * Score one deterministic sample. Returns {score: 0..1, detail}.
 * scoring: 'verdict' | 'exact'. Judge tasks return null (handled elsewhere).
 */
export function scoreSample(task, rawOutput) {
  const scoring = task.scoring;
  if (scoring === 'judge') return null;
  const j = extractJson(rawOutput);
  const chatterPenalty = hasChatter(rawOutput, j) ? 0.5 : 1;

  if (scoring === 'verdict') {
    if (j == null) return { score: 0, detail: 'no-json' };
    const field = task.truth.field ?? 'category';
    const got = normVal(j[field]);
    const want = normVal(task.truth.verdict);
    const hit = got === want;
    return { score: hit ? chatterPenalty : 0, detail: `got=${JSON.stringify(j[field])} want=${JSON.stringify(task.truth.verdict)}` };
  }

  if (scoring === 'exact') {
    if (j == null) return { score: 0, detail: 'no-json' };
    // All requireKeys present?
    const keys = task.truth.requireKeys ?? Object.keys(task.truth.json ?? {});
    for (const k of keys) if (!(k in j)) return { score: 0, detail: `missing key ${k}` };
    // All pinned values match?
    for (const [k, v] of Object.entries(task.truth.json ?? {})) {
      if (normVal(j[k]) !== normVal(v)) return { score: 0, detail: `${k}=${JSON.stringify(j[k])} want ${JSON.stringify(v)}` };
    }
    return { score: chatterPenalty, detail: chatterPenalty < 1 ? 'correct-but-chatter' : 'correct' };
  }

  return { score: 0, detail: `unknown-scoring:${scoring}` };
}

/** Aggregate per-family and overall from an array of {task, samples:[{score}]}. */
export function aggregate(results) {
  const byFamily = {};
  for (const r of results) {
    const scored = r.samples.filter((s) => typeof s.score === 'number');
    if (!scored.length) continue;
    const mean = scored.reduce((a, s) => a + s.score, 0) / scored.length;
    (byFamily[r.family] ??= []).push(mean);
  }
  const familyScores = {};
  for (const [f, arr] of Object.entries(byFamily)) familyScores[f] = arr.reduce((a, b) => a + b, 0) / arr.length;
  const deterministic = Object.entries(familyScores).filter(([f]) => f !== 'agent' && f !== 'background');
  const overallDet = deterministic.length ? deterministic.reduce((a, [, v]) => a + v, 0) / deterministic.length : null;
  return { familyScores, overallDeterministic: overallDet };
}
