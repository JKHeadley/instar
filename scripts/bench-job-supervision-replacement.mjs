/** Opt-in outage-provider battery. Calls pass through the production worker's
 * durable pre-call audit and use the exact replacement prompt. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobSupervisionStore } from '../dist/scheduler/JobSupervisionStore.js';
import { JobSupervisionWorker } from '../dist/scheduler/JobSupervisionWorker.js';
import { parseJobReplacementVerdictStrict, JOB_REPLACEMENT_PROMPT_HASH, JOB_REPLACEMENT_JSON_SCHEMA } from '../dist/scheduler/JobSupervisionReplacementPrompt.js';
import { buildIntelligenceProvider } from '../dist/core/intelligenceProviderFactory.js';
import { scrubForStore } from '../dist/core/durableSecretScrub.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentStateDir = process.env.INSTAR_AGENT_STATE_DIR;
const door = process.argv[2];
const smoke = process.argv.includes('--smoke');
const smokeOne = process.argv.includes('--smoke-one');
const sampleEight = process.argv.includes('--sample-eight');
const casesIndex = process.argv.indexOf('--cases');
if (process.env.INSTAR_LIVE_JOB_SUPERVISION_BENCH !== '1' || !agentStateDir
  || !['luna', 'haiku'].includes(door)) {
  throw new Error('Set INSTAR_LIVE_JOB_SUPERVISION_BENCH=1 and INSTAR_AGENT_STATE_DIR; choose luna or haiku');
}
const corpus = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/job-result-supervision-benchmark-v1.json'), 'utf8'));
const model = door === 'luna' ? 'gpt-6-luna' : 'claude-haiku-4-5-20251001';
// Older Haiku summaries used the alias. Both names debit the same daily cap.
const modelBudgetNames = new Set(door === 'haiku'
  ? ['claude-haiku-4-5', model] : [model]);
const framework = door === 'luna' ? 'codex-cli' : 'claude-code';
const evaluatorVersion = 'strict-json-v2';
const provider = buildIntelligenceProvider({ framework,
  binaryPath: door === 'luna' ? '/usr/local/bin/codex' : '/usr/local/bin/claude' });
if (!provider) throw new Error(`${framework} provider is unavailable`);
const namedCases = casesIndex >= 0 ? (process.argv[casesIndex + 1] ?? '').split(',') : null;
if (namedCases && (namedCases.some(id => !id) || new Set(namedCases).size !== namedCases.length
  || namedCases.some(id => !corpus.cases.some(item => item.id === id)))) {
  throw new Error('--cases requires distinct, known comma-separated corpus IDs');
}
const selected = namedCases ? namedCases.map(id => corpus.cases.find(item => item.id === id))
  : smokeOne ? [corpus.cases[0]]
  : smoke ? [corpus.cases[0], corpus.cases[5], corpus.cases[11]]
  : sampleEight ? [corpus.cases[1], corpus.cases[2], corpus.cases[3], corpus.cases[6],
    corpus.cases[7], corpus.cases[8], corpus.cases[12], corpus.cases[13]] : corpus.cases;
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${door}-${crypto.randomUUID().slice(0, 8)}`;
const benchRoot = path.join(agentStateDir, 'benchmarks', 'job-result-supervision-replacement-v1');
const today = new Date().toISOString().slice(0, 10);
let usedToday = 0;
if (fs.existsSync(benchRoot)) {
  for (const name of fs.readdirSync(benchRoot)) {
    if (!name.startsWith(today)) continue;
    const summaryFile = path.join(benchRoot, name, 'summary.json');
    if (!fs.existsSync(summaryFile)) throw new Error(`incomplete benchmark run needs audit: ${name}`);
    const prior = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    if (modelBudgetNames.has(prior.model)) usedToday += prior.cases.reduce((sum, item) => sum + (item.tokensIn ?? 25_000), 0);
  }
}
if (usedToday + selected.length * 25_000 > 250_000) {
  throw new Error(`replacement benchmark input-token cap would be exceeded: used=${usedToday}, reserved=${selected.length * 25_000}`);
}
const runDir = path.join(benchRoot, runId);
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const store = new JobSupervisionStore(runDir);
const attempts = new Map();
const now = Date.now();
try {
  for (const item of selected) {
    const attemptId = store.register({ runId: `bench:${runId}:${item.id}`, fireId: `bench:${item.id}`,
      slug: `bench-${item.id}`, decisionEligible: true, evidencePolicy: corpus.promptVersion, now });
    const evidenceHash = crypto.createHash('sha256').update(item.evidence).digest('hex');
    store.recordResult(attemptId, { result: 'success', completedAt: new Date(now).toISOString(),
      evidenceHash, evidenceText: item.evidence, evidenceSufficient: item.sufficient });
    attempts.set(item.id, attemptId);
  }
  const worker = new JobSupervisionWorker({ store, readJevKey: () => null, auditReady: () => true,
    replacement: () => ({ model, provider: framework, benchmarkReady: true,
      call: async (prompt, resultRunId, signal, observe) => {
        let actualModel = '';
        let actualProvider = '';
        let usage;
        let raw;
        try { raw = await provider.evaluate(prompt, {
          model: door === 'luna' ? 'gpt-6-luna' : 'fast',
          strictModelPin: true,
          ...(door === 'haiku' ? { reviewerHardening: { model, jsonSchema: JOB_REPLACEMENT_JSON_SCHEMA } } : {}),
          maxTokens: 120, timeoutMs: 30_000, signal,
          attribution: { component: 'JobSupervisionReplacement', category: 'job',
            gating: true, runId: resultRunId },
          onModel: value => {
            if (door === 'luna') { actualModel = value.model; observe({ actualModel }); }
            actualProvider = value.framework ?? '';
            observe({ actualProvider });
          },
          onServedModel: value => {
            if (door === 'haiku') { actualModel = value.model; observe({ actualModel }); }
          },
          onUsage: value => {
            usage = value;
            observe({ tokensIn: value.inputTokens, tokensOut: value.outputTokens });
          },
        }); } catch (error) {
          const cleaned = scrubForStore(error instanceof Error ? error.message : String(error));
          console.error(JSON.stringify({ provider: framework, errorClass: error instanceof Error ? error.name : 'unknown',
            reason: cleaned.error ? 'withheld' : cleaned.text.slice(0, 300) }));
          throw error;
        }
        let verdict = 'cannot-tell';
        let formatValid = true;
        try { verdict = parseJobReplacementVerdictStrict(raw); }
        catch { formatValid = false; }
        return { verdict, formatValid, actualModel, actualProvider,
          tokensIn: usage?.inputTokens, tokensOut: usage?.outputTokens };
      } }),
  });
  await worker.drain(selected.length);
  const cases = selected.map(item => {
    const attemptId = attempts.get(item.id);
    const row = store.get(attemptId);
    const calls = store.callRows(attemptId);
    const replacement = calls.find(c => c.provider === 'replacement') ?? null;
    const correct = row?.verdict === item.expected;
    if (row?.verdict) store.gradeOutcome({ attemptId,
      evidenceId: `${corpus.taskId}:${corpus.promptVersion}:${item.id}`,
      ruleId: 'bench-expected-label-v1', gradedBy: 'independent-benchmark-corpus',
      grade: correct ? 'correct' : 'incorrect' });
    return { id: item.id, expected: item.expected, verdict: row?.verdict ?? null,
      status: row?.status ?? 'missing', reason: row?.reason ?? null, correct,
      latencyMs: replacement?.latency_ms ?? null, tokensIn: replacement?.tokens_in ?? null,
      tokensOut: replacement?.tokens_out ?? null, settlement: replacement?.settlement ?? null };
  });
  const summary = { taskId: corpus.taskId, corpusVersion: corpus.promptVersion,
    promptHash: JOB_REPLACEMENT_PROMPT_HASH, evaluatorVersion, model, framework, runId, smoke,
    budgetInputTokensBefore: usedToday, budgetReservedInputTokens: selected.length * 25_000,
    finishedAt: new Date().toISOString(), total: cases.length,
    correct: cases.filter(c => c.correct).length,
    falseRoutine: cases.filter(c => c.expected === 'needs-session' && c.verdict === 'routine').length,
    unchecked: cases.filter(c => c.status === 'unchecked' || c.status === 'expired-unchecked').length,
    cases };
  const output = path.join(runDir, 'summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId, output, total: summary.total, correct: summary.correct,
    falseRoutine: summary.falseRoutine, unchecked: summary.unchecked }));
} finally { store.close(); }
