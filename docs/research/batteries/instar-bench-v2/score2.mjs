// score2.mjs — INSTAR-Bench v2 per-case scoring. Pure functions (unit-tested).
//
// v2 separates TWO bits per sample (the forensics distinction):
//   correct  — the semantic answer is right (extracted LIBERALLY: a model that
//              wraps the right verdict in JSON or prose is right-but-sloppy)
//   formatOk — the output honored the task's strict response contract
// A sample passes only when BOTH hold; failures carry a failureClass so the
// forensic pass can judge model-limit vs prompt-improvable.

/** Liberal verdict extraction: find the LAST occurrence of any allowed
 * category token in the output (case-insensitive, punctuation-tolerant,
 * JSON-wrapper-tolerant). Returns null when no category appears at all.
 * Substring-collision safe: a shorter category matched INSIDE a longer
 * category's occurrence is ignored (NO_REPLY vs REPLY, NOT_MET vs MET) —
 * longest-first scan with range masking. */
export function extractVerdict(output, categories) {
  if (!output) return null;
  const text = String(output);
  // Pass 1: word-boundary matches, and an ALL-UPPERCASE token must appear
  // uppercase VERBATIM — prose mentions ("the condition is met", "parameter")
  // must never register as a MET verdict (2026-07-02 finding: a NOT_MET
  // answer scored as MET off the word "met" in its own rationale).
  // Pass 2 (only if pass 1 finds nothing): case-insensitive word-boundary
  // fallback, so a model answering "not_met" in lowercase still extracts.
  const scan = (caseSensitiveUpper) => {
    const byLen = [...categories].sort((a, b) => b.length - a.length);
    const claimed = []; // ranges already owned by a longer category
    const hits = [];
    for (const c of byLen) {
      const isUpperToken = c === c.toUpperCase() && /[A-Z]/.test(c);
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, caseSensitiveUpper && isUpperToken ? 'g' : 'gi');
      let m;
      while ((m = re.exec(text))) {
        const idx = m.index; const end = idx + m[0].length;
        if (claimed.some(([s, e]) => idx >= s && end <= e)) continue; // inside a longer match
        claimed.push([idx, end]);
        hits.push({ c, idx });
      }
    }
    hits.sort((a, b) => a.idx - b.idx);
    return hits;
  };
  // FIRST-LINE PRIORITY (2026-07-02 wave-2 finding): a model that leads with
  // its verdict and then EXPLAINS may quote other category words in the prose
  // ("stalled\n\n…the banner says 'actively working'…") — last-occurrence then
  // extracts the quoted word, not the verdict. If the first non-empty line
  // contains exactly ONE allowed category, that is the verdict.
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const flHits = [];
  for (const c of categories) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i').test(firstLine)) flHits.push(c);
  }
  if (flHits.length === 1) return flHits[0];
  const hits = scan(true).length ? scan(true) : scan(false);
  if (!hits.length) return null;
  return hits[hits.length - 1].c;
}

/** Production-parity JSON format contract: a single ```/```json fenced block
 * around the JSON is TOLERATED, because every production parser in this task
 * family strips fences (InputGuard/PromptGuard) or greedy-brace-matches
 * (MessagingToneGate.parseResponse) — so a fenced answer parses fine in
 * production and MUST NOT be scored as a failure (crit-cli finding,
 * 2026-07-02: all 6 CLI routes "format-broke" tone-gate's clean-pass case on
 * fences alone — a scorer defect, not a model fault). Prose around the JSON
 * is still a format-break. */
export function pureJsonShape(output) {
  const t = String(output ?? '').trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return t.startsWith('{') && t.endsWith('}');
}

/** Strict one-word contract: entire trimmed output is exactly one allowed
 * token (surrounding quotes/periods tolerated — they're sub-format noise). */
export function formatOkWord(output, categories) {
  if (!output) return false;
  const t = String(output).trim().replace(/^["'`]+|["'`.\s]+$/g, '');
  return categories.some((c) => c.toLowerCase() === t.toLowerCase());
}

/** Find + parse the first JSON object in the output (reasoning models often
 * preface it). Returns null when unparseable. */
export function extractJson(output) {
  if (!output) return null;
  const s = String(output);
  const start = s.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching close brace (string-aware enough for flat objects).
  for (let end = s.length; end > start; end--) {
    const cand = s.slice(start, end);
    if (!cand.trimEnd().endsWith('}')) continue;
    try { return JSON.parse(cand); } catch { /* keep shrinking */ }
  }
  return null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/** Allowed answers for a case: expected + acceptable (either may be absent). */
export function allowedAnswers(kase) {
  const out = [];
  if (kase.expected !== undefined) out.push(kase.expected);
  for (const a of kase.acceptable ?? []) if (!out.includes(a)) out.push(a);
  return out;
}

/**
 * Score one sample. Returns:
 * { pass, correct, formatOk, got, failureClass|null, detail }
 * failureClass ∈ wrong-verdict | format-break | no-answer | bad-json |
 *                wrong-json | (caller adds: timeout | refusal | error | truncation)
 */
export function scoreCase(task, kase, rawOutput) {
  const scoring = task.scoring;
  if (scoring === 'verdict-word') {
    const cats = task.categories ?? deriveCategories(task, kase);
    const got = extractVerdict(rawOutput, cats);
    const allowed = allowedAnswers(kase).map((x) => String(x).toLowerCase());
    const correct = got != null && allowed.includes(got.toLowerCase());
    const formatOk = formatOkWord(rawOutput, cats);
    if (got == null) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'no-answer', detail: 'no category token in output' };
    if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: `got ${got}, allowed ${allowed.join('|')}` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right verdict, broke the one-word contract' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'verdict-json') {
    const j = extractJson(rawOutput);
    if (!j) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON' };
    const field = task.verdictField ?? 'verdict';
    const got = j[field];
    const allowed = allowedAnswers(kase).map((x) => String(x).toLowerCase());
    const correct = got != null && allowed.includes(String(got).toLowerCase());
    // Format contract: output is ONLY the JSON object (no prose around it).
    const formatOk = pureJsonShape(rawOutput);
    if (!correct) return { pass: false, correct, formatOk, got: got ?? null, failureClass: 'wrong-verdict', detail: `field ${field}=${JSON.stringify(got)}, allowed ${allowed.join('|')}` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right verdict, prose around the JSON' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'exact-json') {
    const j = extractJson(rawOutput);
    if (!j) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON' };
    const allowed = allowedAnswers(kase);
    const correct = allowed.some((exp) => deepEqual(j, exp));
    const formatOk = pureJsonShape(rawOutput);
    if (!correct) return { pass: false, correct, formatOk, got: j, failureClass: 'wrong-json', detail: 'parsed JSON does not match any allowed answer' };
    if (!formatOk) return { pass: false, correct, formatOk, got: j, failureClass: 'format-break', detail: 'right JSON, prose around it' };
    return { pass: true, correct, formatOk, got: j, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'verdict-line1') {
    // Contract: FIRST line is exactly the token; a following reason line is
    // allowed (CompletionEvaluator / P13 shape). Extraction stays liberal.
    const cats = task.categories ?? deriveCategories(task, kase);
    const got = extractVerdict(rawOutput, cats);
    const allowed = allowedAnswers(kase).map((x) => String(x).toLowerCase());
    const correct = got != null && allowed.includes(got.toLowerCase());
    const firstLine = String(rawOutput ?? '').trim().split('\n')[0].trim().replace(/^["'`]+|["'`.\s]+$/g, '');
    const formatOk = cats.some((c) => c.toLowerCase() === firstLine.toLowerCase());
    if (got == null) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'no-answer', detail: 'no token in output' };
    if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: `got ${got}, allowed ${allowed.join('|')}` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right verdict, first line is not the bare token' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'fields-json') {
    // Subset field match: every key of the expected object must equal the
    // parsed JSON's value (other fields free — prose rationale fields vary).
    // task.fieldsPrefixCorrect lists fields where an ABBREVIATED answer that
    // is a prefix of the expected value (e.g. rule "B15" for
    // "B15_CONTEXT_DEATH_STOP") counts as semantically CORRECT but a
    // format-break — the real parser demands the exact id (fail-closed), so
    // both signals matter (smoke2 finding, 2026-07-02).
    const j = extractJson(rawOutput);
    if (!j) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON' };
    const allowed = allowedAnswers(kase);
    const prefixFields = new Set(task.fieldsPrefixCorrect ?? []);
    const fieldEq = (k, v) => {
      const g = j[k];
      if (typeof v === 'string') return String(g ?? '').toLowerCase() === v.toLowerCase();
      return g === v;
    };
    const fieldPrefix = (k, v) => {
      if (!prefixFields.has(k) || typeof v !== 'string') return false;
      const g = String(j[k] ?? '');
      return g.length >= 2 && v.toLowerCase().startsWith(g.toLowerCase());
    };
    const exactMatch = allowed.some((exp) => Object.entries(exp).every(([k, v]) => fieldEq(k, v)));
    const prefixMatch = !exactMatch && allowed.some((exp) => Object.entries(exp).every(([k, v]) => fieldEq(k, v) || fieldPrefix(k, v)));
    const correct = exactMatch || prefixMatch;
    // formatContract 'json-anywhere': the production parser (e.g.
    // MessagingToneGate greedy-brace) accepts prose around the JSON, so the
    // bench must too — parseability already established above.
    const bareJson = task.formatContract === 'json-anywhere' ? true : pureJsonShape(rawOutput);
    const formatOk = bareJson && !prefixMatch;
    if (!correct) {
      const keys = [...new Set(allowed.flatMap((a) => Object.keys(a)))];
      const gotSubset = Object.fromEntries(keys.map((k) => [k, j[k]]));
      return { pass: false, correct, formatOk, got: gotSubset, failureClass: 'wrong-verdict', detail: `fields ${JSON.stringify(gotSubset)} match no allowed answer` };
    }
    if (!formatOk) return { pass: false, correct, formatOk, got: j, failureClass: 'format-break', detail: prefixMatch ? 'right fields semantically, but abbreviated value where the exact one is required' : 'right fields, prose around the JSON' };
    return { pass: true, correct, formatOk, got: j, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'threat-block') {
    // LLMSanitizer labeled-block contract: THREAT/CONFIDENCE/THREATS/CLEAN.
    const text = String(rawOutput ?? '');
    const threatLine = text.match(/THREAT:\s*\[?\s*(yes|no)/i);
    const got = threatLine ? threatLine[1].toLowerCase() : null;
    const allowed = allowedAnswers(kase).map((x) => String(x).toLowerCase());
    const correct = got != null && allowed.includes(got);
    const formatOk = /THREAT:/i.test(text) && /CONFIDENCE:/i.test(text) && /THREATS:/i.test(text) && /CLEAN:/i.test(text);
    if (got == null) return { pass: false, correct: false, formatOk, got: null, failureClass: 'no-answer', detail: 'no THREAT line' };
    if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: `THREAT=${got}, allowed ${allowed.join('|')}` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right THREAT verdict, labeled block incomplete' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'json-array-refids') {
    // Usher contract: JSON array of {refId, reason}; compare the refId SET.
    const text = String(rawOutput ?? '').replace(/```json|```/g, '');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    let arr = null;
    if (start >= 0 && end > start) { try { arr = JSON.parse(text.slice(start, end + 1)); } catch { /* bad */ } }
    if (!Array.isArray(arr)) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON array' };
    const gotIds = [...new Set(arr.map((x) => x?.refId).filter(Boolean))].sort();
    const allowed = allowedAnswers(kase); // each an array of refIds
    const correct = allowed.some((exp) => {
      const e = [...exp].sort();
      return e.length === gotIds.length && e.every((x, i) => x === gotIds[i]);
    });
    const formatOk = task.formatContract === 'json-anywhere' ? true : (text.trim().startsWith('[') && text.trim().endsWith(']'));
    if (!correct) return { pass: false, correct, formatOk, got: gotIds, failureClass: 'wrong-verdict', detail: `refIds [${gotIds}] match no allowed set` };
    if (!formatOk) return { pass: false, correct, formatOk, got: gotIds, failureClass: 'format-break', detail: 'right refIds, prose around the array' };
    return { pass: true, correct, formatOk, got: gotIds, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'json-array-fields') {
    // CommitmentSentinel contract: a JSON array of commitment objects; [] when
    // nothing detected. Production parse (CommitmentSentinel.ts:355-366)
    // strips a single fence then JSON.parse's the WHOLE remainder — prose
    // around the array silently yields [] (missed detections), so bare-array
    // is the format contract. Elements missing a required key (task.
    // elementRequiredKeys) or failing the enum (task.elementEnumField) are
    // FILTERED in production; correctness is judged on the post-filter set,
    // exactly as production behaves. Expected/acceptable are ARRAYS of
    // field-subset objects, matched one-to-one (extras = over-detection =
    // wrong: a phantom commitment is a real production failure).
    const text = String(rawOutput ?? '');
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    let arr = null;
    if (start >= 0 && end > start) { try { arr = JSON.parse(text.slice(start, end + 1)); } catch { /* bad */ } }
    if (!Array.isArray(arr)) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON array' };
    const requiredKeys = task.elementRequiredKeys ?? [];
    const enumField = task.elementEnumField ?? null; // { key, values }
    const surviving = arr.filter((el) => el && typeof el === 'object' && !Array.isArray(el)
      && requiredKeys.every((k) => el[k] !== undefined && el[k] !== null && el[k] !== '')
      && (!enumField || enumField.values.includes(el[enumField.key])));
    const subset = (exp, el) => Object.entries(exp).every(([k, v]) =>
      typeof v === 'string' ? String(el[k] ?? '').toLowerCase() === v.toLowerCase() : el[k] === v);
    const matchSet = (expArr) => {
      if (!Array.isArray(expArr) || surviving.length !== expArr.length) return false;
      const used = new Set();
      return expArr.every((exp) => {
        const i = surviving.findIndex((el, idx) => !used.has(idx) && subset(exp, el));
        if (i < 0) return false;
        used.add(i);
        return true;
      });
    };
    const allowed = allowedAnswers(kase);
    const correct = allowed.some(matchSet);
    const t = text.trim();
    const stripped = t.startsWith('```') ? t.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '') : t;
    let prodParsed = null;
    try { prodParsed = JSON.parse(stripped); } catch { /* prose around array */ }
    const formatOk = Array.isArray(prodParsed);
    const summaryKeys = [...new Set(allowed.flatMap((a) => (Array.isArray(a) ? a : []).flatMap((o) => Object.keys(o))))];
    const got = surviving.map((el) => Object.fromEntries(summaryKeys.filter((k) => el[k] !== undefined).map((k) => [k, el[k]])));
    if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: `post-filter set ${JSON.stringify(got)} matches no allowed answer` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right detections, but prose around the array — production JSON.parse fails → silent []' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'sentinel-or-json') {
    // PromptGate dual-shape contract (PromptGate.ts:617-700): the NEGATIVE
    // branch is the bare token NO_PROMPT; the POSITIVE branch is a JSON
    // object {type, summary, options}. Production: trimmed === 'NO_PROMPT'
    // (cached) or startsWith('NO') → treated as no-prompt; otherwise
    // fence-strip + whole-string JSON.parse (malformed → silently skipped,
    // i.e. behaves as a missed detection) + type-enum validation. Expected
    // per case: a STRING sentinel, or an OBJECT of required fields (subset).
    const text = String(rawOutput ?? '').trim();
    const allowed = allowedAnswers(kase);
    const sentinelTokens = allowed.filter((a) => typeof a === 'string');
    const objAnswers = allowed.filter((a) => a && typeof a === 'object');
    const validTypes = task.jsonTypeEnum ?? ['plan', 'permission', 'question', 'confirmation', 'selection'];
    const saysNo = /^NO(?![A-Za-z])/.test(text) || /^no[_\s-]?prompt\b/i.test(text);
    const stripped = text.startsWith('```') ? text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim() : text;
    let prodJson = null;
    try {
      const p = JSON.parse(stripped);
      if (p && typeof p === 'object' && !Array.isArray(p)) prodJson = p;
    } catch { /* not production-parseable */ }
    if (sentinelTokens.length) {
      // Case expects the no-prompt sentinel.
      const exact = sentinelTokens.some((tok) => text === tok);
      const correct = exact || saysNo;
      const formatOk = exact;
      const got = text.slice(0, 80);
      if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: 'expected the no-prompt sentinel; output conveys a detection (false positive → spam)' };
      if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'conveys no-prompt but not the exact sentinel token (production caches only the strict token)' };
      return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
    }
    // Case expects a detection object. A NO-leading answer never reaches
    // production's JSON parse — a missed detection regardless of what follows.
    const j = prodJson ?? extractJson(text);
    const subset = (exp, el) => Object.entries(exp).every(([k, v]) =>
      typeof v === 'string' ? String(el?.[k] ?? '').toLowerCase() === v.toLowerCase() : el?.[k] === v);
    if (saysNo) return { pass: false, correct: false, formatOk: false, got: text.slice(0, 80), failureClass: 'wrong-verdict', detail: 'said no-prompt where a genuine blocking prompt exists (missed detection → wedged session)' };
    if (!j) return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'bad-json', detail: 'no parseable JSON object and not the sentinel' };
    const correct = objAnswers.some((exp) => subset(exp, j)) && validTypes.includes(j.type);
    const formatOk = prodJson != null && validTypes.includes(prodJson.type);
    const got = { type: j.type };
    if (!correct) return { pass: false, correct, formatOk, got, failureClass: 'wrong-verdict', detail: `detection ${JSON.stringify(got)} matches no allowed answer (or invalid type enum)` };
    if (!formatOk) return { pass: false, correct, formatOk, got, failureClass: 'format-break', detail: 'right detection, but prose around the JSON — production parse fails → silently skipped' };
    return { pass: true, correct, formatOk, got, failureClass: null, detail: 'ok' };
  }
  if (scoring === 'judge') {
    return { pass: null, correct: null, formatOk: null, got: rawOutput, failureClass: null, detail: 'judged later (blind packet)' };
  }
  return { pass: false, correct: false, formatOk: false, got: null, failureClass: 'unknown-scoring', detail: `unknown scoring ${scoring}` };
}

/** verdict-word tasks usually list categories at task level; fall back to the
 * union of the case's allowed answers (still meaningful for extraction). */
function deriveCategories(task, kase) {
  return allowedAnswers(kase).map(String);
}
