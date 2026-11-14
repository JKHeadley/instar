/**
 * LayerUpdate spend per day by trigger (context-budget-layered-summaries §11:
 * "extractor calls and tokens per day by trigger").
 *
 * One small JSON file per machine, `<stateDir>/server-data/context-budget-layer-spend.json`,
 * holding a rollup per UTC day (kept 35 days) and per trigger (`turn` = an
 * operator/agent message, `tick` = a transcript-growth tick):
 *
 *  - `attempts`  — capture attempts that reached the layer path;
 *  - `calls`     — of those, the ones that reached the extractor (an LLM call);
 *  - `updated`   — calls that moved the awareness (a layer was written);
 *  - `deferred`  — attempts deferred by the layer budget or shed under quota;
 *  - `errors`    — attempts that degraded;
 *  - `tokensIn` / `tokensOut` / `tokensCached` — provider-reported usage;
 *  - `measuredCalls` — calls whose provider reported usage at all (a framework
 *    that reports no tokens leaves the token totals partial; the gap is
 *    `calls − measuredCalls`, never filled with an estimate).
 *
 * Each attempt is also a `LayerUpdate` row on `/metrics/features` (kind
 * `event`: the tokens stay on the `TopicIntentExtractor` rows, never counted
 * twice). Signal-only: nothing reads this to decide anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type LayerTrigger = 'turn' | 'tick';

export interface LayerSpendCounts {
  attempts: number;
  calls: number;
  updated: number;
  deferred: number;
  errors: number;
  measuredCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
}

export interface LayerSpendDay { day: string; turn: LayerSpendCounts; tick: LayerSpendCounts }

const KEEP_DAYS = 35;

function zero(): LayerSpendCounts {
  return { attempts: 0, calls: 0, updated: 0, deferred: 0, errors: 0, measuredCalls: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
}

export function layerSpendFile(stateDir: string): string {
  return path.join(stateDir, 'server-data', 'context-budget-layer-spend.json');
}

export class LayerSpendLog {
  private days = new Map<string, LayerSpendDay>();
  private loaded = false;
  private writeFailures = 0;

  constructor(private readonly o: { file: string; now?: () => number }) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.o.file, 'utf-8')) as { days?: LayerSpendDay[] };
      for (const d of raw.days ?? []) {
        if (d && typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day)) this.days.set(d.day, { day: d.day, turn: { ...zero(), ...d.turn }, tick: { ...zero(), ...d.tick } });
      }
    } catch { /* @silent-fallback-ok — no file yet, or a torn one: start an empty rollup (the counts are observability) */ }
  }

  private bucket(trigger: LayerTrigger): LayerSpendCounts {
    this.load();
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let d = this.days.get(day);
    if (!d) {
      d = { day, turn: zero(), tick: zero() };
      this.days.set(day, d);
      const keep = [...this.days.keys()].sort().slice(-KEEP_DAYS);
      for (const k of [...this.days.keys()]) if (!keep.includes(k)) this.days.delete(k);
    }
    return d[trigger];
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: 'layer-spend/1', days: [...this.days.values()] }), { mode: 0o600 });
      fs.renameSync(tmp, this.o.file);
    } catch (err) {
      // Not silent: counted on the status and logged once per ten failures; the in-memory rollup stands.
      this.writeFailures++;
      if (this.writeFailures % 10 === 1) console.warn(`[context-layers] layer spend rollup write failed: ${(err as Error).message}`);
    }
  }

  /** One capture attempt that reached the layer path. */
  recordAttempt(trigger: LayerTrigger, o: { called: boolean; updated: boolean; deferred: boolean; error: boolean }): void {
    const b = this.bucket(trigger);
    b.attempts++;
    if (o.called) b.calls++;
    if (o.updated) b.updated++;
    if (o.deferred) b.deferred++;
    if (o.error) b.errors++;
    this.persist();
  }

  /** Provider-reported usage of one extractor call. */
  recordUsage(trigger: LayerTrigger, u: { inputTokens: number; outputTokens: number; cachedTokens?: number }): void {
    const b = this.bucket(trigger);
    b.measuredCalls++;
    b.tokensIn += Math.max(0, Number(u.inputTokens) || 0);
    b.tokensOut += Math.max(0, Number(u.outputTokens) || 0);
    b.tokensCached += Math.max(0, Number(u.cachedTokens) || 0);
    this.persist();
  }

  /** The newest `days` days, oldest first. */
  byDay(days = 30): LayerSpendDay[] {
    this.load();
    return [...this.days.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-Math.max(1, Math.min(KEEP_DAYS, days)))
      .map((d) => ({ day: d.day, turn: { ...d.turn }, tick: { ...d.tick } }));
  }

  writeFailureCount(): number { return this.writeFailures; }
}
