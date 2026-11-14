#!/usr/bin/env node
/**
 * topic-intent-inventory — Phase 0 measurement for
 * docs/specs/context-budget-layered-summaries.md (§16 item 1, "the topic-intent
 * layer inventory"; check 7 of docs/specs/reports/context-budget-phase0-results.md).
 *
 * READ-ONLY against the local agent server. For every topic the server maps to
 * a session (GET /telegram/topics) plus every topic that has a topic-intent
 * store file (<agentHome>/.instar/topic-intent/<id>.json), it reads:
 *   - GET /topic-intent/:id/diagnostics (read-only: refs with tiers, awareness, pending);
 *   - GET /telegram/topics/:id/messages?limit=100 (the newest 100 messages).
 * It deliberately does NOT call GET /topic-intent/:id/briefing, because that
 * route increments the briefing_served capture counters (a probe would distort
 * the very funnel it measures). "Briefing exists" is computed with the same
 * emptiness rule as renderTopicIntentBriefing: no awareness, no tentative-or-
 * better ref and no outstanding pending confirm ⇒ empty briefing. (The arc
 * frame refs are not reproduced here; they come only from refs, so a topic with
 * no tentative ref and no awareness renders empty either way.)
 *
 * Freshness = the newest evidence `at` across refs. Messages behind = topic
 * messages (either direction) whose messageId is above the newest evidence
 * sourceMessageId, counted inside the newest 100 (so "100" means "100 or more").
 *
 * Usage: AUTH=... node scripts/context-budget/topic-intent-inventory.mjs [--agent-home DIR] [--port 4040] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const home = opt('--agent-home', path.join(os.homedir(), '.instar', 'agents', 'echo'));
const port = opt('--port', '4040');
const auth = process.env.AUTH;
if (!auth) { console.error('set AUTH to the agent auth token'); process.exit(2); }
const base = `http://localhost:${port}`;
const get = async (p) => {
  const r = await fetch(base + p, { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return { __status: r.status };
  return r.json();
};

const topicsResp = await get('/telegram/topics');
const mapped = new Map((topicsResp.topics ?? []).map((t) => [t.topicId, t.sessionName]));
const storeDir = path.join(home, '.instar', 'topic-intent');
const stored = fs.existsSync(storeDir) ? fs.readdirSync(storeDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.slice(0, -5))) : [];
const ids = [...new Set([...mapped.keys(), ...stored])].sort((a, b) => a - b);

const now = Date.now();
const rows = [];
for (const id of ids) {
  const diag = await get(`/topic-intent/${id}/diagnostics`);
  const msgs = await get(`/telegram/topics/${id}/messages?limit=100`);
  const refs = Array.isArray(diag.refs) ? diag.refs : [];
  const tiers = diag.tierDistribution ?? { observation: 0, tentative: 0, authoritative: 0 };
  let newestAt = 0; let newestSrc = -1;
  for (const r of refs) for (const e of r.recentEvidence ?? []) {
    const t = Date.parse(e.at ?? ''); if (Number.isFinite(t) && t > newestAt) newestAt = t;
    const s = Number(e.sourceMessageId); if (Number.isFinite(s) && s > newestSrc) newestSrc = s;
  }
  const list = Array.isArray(msgs.messages) ? msgs.messages : [];
  const lastMsgAt = list.reduce((m, x) => Math.max(m, Date.parse(x.timestamp ?? '') || 0), 0);
  const behind = newestSrc >= 0 ? list.filter((x) => Number(x.messageId) > newestSrc).length : list.length;
  const briefingNonEmpty = !!diag.awareness || (tiers.tentative + tiers.authoritative) > 0 || !!diag.pending?.outstanding;
  rows.push({
    topicId: id, session: mapped.get(id) ?? null, storeFile: stored.includes(id),
    refs: refs.length, tiers, awareness: !!diag.awareness, briefingNonEmpty,
    newestEvidenceAt: newestAt ? new Date(newestAt).toISOString() : null,
    ageHours: newestAt ? +((now - newestAt) / 3_600_000).toFixed(1) : null,
    lastMessageAt: lastMsgAt ? new Date(lastMsgAt).toISOString() : null,
    messagesInWindow: list.length, messagesBehind: behind,
  });
}

const active = (r) => r.lastMessageAt && now - Date.parse(r.lastMessageAt) < 7 * 86_400_000;
const sum = (rs) => ({
  topics: rs.length,
  withStoreFile: rs.filter((r) => r.storeFile).length,
  withAnyRef: rs.filter((r) => r.refs > 0).length,
  briefingNonEmpty: rs.filter((r) => r.briefingNonEmpty).length,
  withAwareness: rs.filter((r) => r.awareness).length,
  freshUnder24h: rs.filter((r) => r.ageHours !== null && r.ageHours < 24).length,
  behind0: rs.filter((r) => r.refs > 0 && r.messagesBehind === 0).length,
  behind1to10: rs.filter((r) => r.refs > 0 && r.messagesBehind >= 1 && r.messagesBehind <= 10).length,
  behindOver10: rs.filter((r) => r.refs > 0 && r.messagesBehind > 10).length,
});
const out = { machine: os.hostname(), at: new Date(now).toISOString(), all: sum(rows), activeLast7d: sum(rows.filter(active)), rows };
if (args.includes('--json')) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
else {
  console.log(JSON.stringify({ machine: out.machine, at: out.at, all: out.all, activeLast7d: out.activeLast7d }, null, 2));
  for (const r of rows) console.log(`${r.topicId}\t${r.session ?? '-'}\trefs=${r.refs}\tT=${r.tiers.tentative}/A=${r.tiers.authoritative}\taw=${r.awareness}\tbrief=${r.briefingNonEmpty}\tage=${r.ageHours}h\tbehind=${r.messagesBehind}/${r.messagesInWindow}\tlast=${r.lastMessageAt}`);
}
