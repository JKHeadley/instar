#!/usr/bin/env node
/**
 * threadline-bridge-backfill.mjs — one-shot backfill of threadline messages
 * into Telegram topics via the local agent's HTTP API.
 *
 * Use case: the canonical inbox / outbox files (introduced in PRs #113
 * and #118) accrue going forward, and the bridge module (#117) mirrors
 * NEW traffic into Telegram topics. But threads that landed BEFORE the
 * bridge shipped — including the four documented in topic-8686 — need to
 * be reconstructed manually so the user has visibility on those too.
 *
 * What this script does:
 *
 *   1. Reads the agent's canonical inbox/outbox JSONL files.
 *   2. Optionally enriches with a seed file (--seed) of historical
 *      messages reconstructed from spawn-session transcripts.
 *   3. For each thread to backfill (default: all threads with no
 *      existing bridge binding):
 *        a. POST /telegram/topics with a bridge-style name.
 *        b. POST a backfill banner explaining what the user is seeing.
 *        c. POST each message chronologically, chunked under 4000 chars.
 *   4. Records what it did in
 *      .instar/threadline/bridge-backfill-ledger.json so reruns are
 *      idempotent — already-backfilled threads are skipped.
 *
 * Safety:
 *   - --dry-run prints the plan without making any HTTP calls.
 *   - --threads <id1,id2,...> limits to specific threadIds.
 *   - --no-create skips topic creation; only posts when a binding
 *     already exists.
 *   - 250ms gap between sends to avoid hitting Telegram rate limits.
 *
 * Usage:
 *   node scripts/threadline-bridge-backfill.mjs [--state-dir .instar] \
 *        [--port 4042] [--threads tA,tB] [--seed seed.json] \
 *        [--dry-run] [--no-create]
 *
 * The seed file format is a JSON array of message records:
 *   [
 *     {
 *       "threadId": "thread-bdc12cb0",
 *       "direction": "in" | "out",
 *       "timestamp": "2026-04-28T12:34:56Z",
 *       "remoteAgent": "fp-dawn",
 *       "remoteAgentName": "Dawn",
 *       "text": "..."
 *     },
 *     ...
 *   ]
 * Seed messages are merged with the on-disk inbox/outbox per thread,
 * sorted chronologically, and posted as one stream.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ARGS = parseArgs(process.argv.slice(2));
const STATE_DIR = path.resolve(ARGS['--state-dir'] ?? '.instar');
const PORT = parseInt(ARGS['--port'] ?? '4042', 10);
const DRY_RUN = '--dry-run' in ARGS;
const NO_CREATE = '--no-create' in ARGS;
const ONLY_THREADS = (ARGS['--threads'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const SEED_PATH = ARGS['--seed'];
const SEND_GAP_MS = 250;
const MAX_BODY_CHARS = 3800; // Telegram cap is 4096; leave room for headers
const TOPIC_NAME_MAX = 96;

const AUTH = readAuthToken();
const BASE = `http://localhost:${PORT}`;
const LEDGER_PATH = path.join(STATE_DIR, 'threadline', 'bridge-backfill-ledger.json');

const log = (msg) => console.log(`[backfill] ${msg}`);
const warn = (msg) => console.warn(`[backfill] ${msg}`);

main().catch(err => {
  console.error(`[backfill] FATAL: ${err.stack || err.message || err}`);
  process.exit(1);
});

async function main() {
  const inbox = readJsonl(path.join(STATE_DIR, 'threadline', 'inbox.jsonl.active'));
  const outbox = readJsonl(path.join(STATE_DIR, 'threadline', 'outbox.jsonl.active'));
  const bindings = loadBindings();
  const ledger = loadLedger();
  const seed = loadSeed(SEED_PATH);

  const byThread = groupByThread(inbox, outbox, seed);
  const targetIds = ONLY_THREADS.length > 0 ? ONLY_THREADS : Array.from(byThread.keys());
  log(`Found ${byThread.size} threads in canonical files; targeting ${targetIds.length} for backfill (dry-run=${DRY_RUN}).`);

  let bridgedCount = 0;
  let postedCount = 0;
  for (const threadId of targetIds) {
    const messages = byThread.get(threadId) ?? [];
    if (messages.length === 0) {
      warn(`thread ${threadId.slice(0, 12)}: no messages on disk or in seed; skipping`);
      continue;
    }
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    const existingBinding = bindings.get(threadId);
    let topicId = existingBinding?.topicId;
    let topicName = existingBinding?.topicName;
    const remoteAgent = pickCounterparty(messages);

    if (!topicId) {
      if (NO_CREATE) {
        warn(`thread ${threadId.slice(0, 12)}: no binding and --no-create — skipping`);
        continue;
      }
      const localAgentName = readAgentName();
      topicName = buildTopicName(localAgentName, remoteAgent.name, messages[0]?.text || 'reconstructed thread');
      if (DRY_RUN) {
        log(`[plan] CREATE topic "${topicName}" for thread ${threadId.slice(0, 12)} (${messages.length} msgs)`);
      } else {
        const created = await createTopic(topicName);
        topicId = created.topicId;
        log(`Created topic ${topicId} ("${topicName}") for thread ${threadId.slice(0, 12)}`);
      }
      bridgedCount++;
    }

    // Banner
    const bannerLines = [
      '📚 Backfill: reconstructed thread history',
      `Thread: ${threadId}`,
      `Remote agent: ${remoteAgent.name} (${remoteAgent.id})`,
      `Messages: ${messages.length} (${messages.filter(m => m.direction === 'in').length} in / ${messages.filter(m => m.direction === 'out').length} out)`,
      `Span: ${messages[0]?.timestamp || 'unknown'} → ${messages[messages.length-1]?.timestamp || 'unknown'}`,
      '',
      'New traffic on this thread will mirror in real time once the bridge is enabled.',
    ];
    const banner = bannerLines.join('\n');
    if (DRY_RUN) {
      log(`[plan] POST banner to topic ${topicId ?? '(would-create)'}`);
    } else if (topicId) {
      await postToTopic(topicId, banner);
      await sleep(SEND_GAP_MS);
    }

    // Messages
    const ledgerThread = ledger.threads[threadId] ?? { posted: [] };
    const alreadyPosted = new Set(ledgerThread.posted);
    let postedThisRun = 0;
    for (const m of messages) {
      const key = m.id || `${m.direction}:${m.timestamp}:${m.text.slice(0, 32)}`;
      if (alreadyPosted.has(key)) continue;
      const formatted = formatBackfillMessage(m, remoteAgent);
      const chunks = chunkBody(formatted);
      for (const chunk of chunks) {
        if (DRY_RUN) {
          log(`[plan] POST to topic ${topicId ?? '?'}: ${oneLine(chunk).slice(0, 80)}…`);
        } else if (topicId) {
          await postToTopic(topicId, chunk);
          await sleep(SEND_GAP_MS);
        }
      }
      alreadyPosted.add(key);
      postedThisRun++;
      postedCount++;
    }

    if (!DRY_RUN) {
      ledger.threads[threadId] = {
        topicId: topicId ?? null,
        topicName: topicName ?? null,
        posted: Array.from(alreadyPosted),
        lastBackfillAt: new Date().toISOString(),
      };
      saveLedger(ledger);
    }
    log(`Thread ${threadId.slice(0, 12)}: posted ${postedThisRun} new message(s).`);
  }

  log(`Done. Threads bridged this run: ${bridgedCount}; messages posted: ${postedCount}; dry-run: ${DRY_RUN}.`);
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[a] = next; i++; }
      else { out[a] = ''; }
    }
  }
  return out;
}

function readAuthToken() {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg.authToken ?? '';
  } catch { return ''; }
}

function readAgentName() {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg.projectName || 'agent';
  } catch { return 'agent'; }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadBindings() {
  const map = new Map();
  const filePath = path.join(STATE_DIR, 'threadline', 'telegram-bridge-bindings.json');
  if (!fs.existsSync(filePath)) return map;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const b of parsed.bindings ?? []) {
      if (b.threadId) map.set(b.threadId, b);
    }
  } catch { /* ignore */ }
  return map;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return { version: 1, threads: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
    if (!parsed.threads) parsed.threads = {};
    return parsed;
  } catch {
    return { version: 1, threads: {} };
  }
}

function saveLedger(ledger) {
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

function loadSeed(seedPath) {
  if (!seedPath) return [];
  if (!fs.existsSync(seedPath)) {
    warn(`Seed file not found: ${seedPath}`);
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    if (!Array.isArray(parsed)) {
      warn(`Seed file did not parse as array; ignoring`);
      return [];
    }
    return parsed;
  } catch (err) {
    warn(`Failed to parse seed file: ${err.message}`);
    return [];
  }
}

function groupByThread(inbox, outbox, seed) {
  const map = new Map();
  const push = (threadId, msg) => {
    if (!threadId) return;
    if (!map.has(threadId)) map.set(threadId, []);
    map.get(threadId).push(msg);
  };
  for (const e of inbox) {
    push(e.threadId, {
      id: e.id,
      direction: 'in',
      timestamp: e.timestamp,
      remoteAgent: e.from,
      remoteAgentName: e.senderName || e.from?.slice(0, 8) || '(unknown)',
      text: e.text || '',
    });
  }
  for (const e of outbox) {
    push(e.threadId, {
      id: e.id,
      direction: 'out',
      timestamp: e.timestamp,
      remoteAgent: e.to,
      remoteAgentName: e.recipientName || e.to?.slice(0, 8) || '(unknown)',
      text: e.text || '',
      outcome: e.outcome,
    });
  }
  for (const e of seed) {
    if (!e.threadId) continue;
    push(e.threadId, {
      id: e.id ?? `seed-${e.timestamp ?? ''}`,
      direction: e.direction === 'out' ? 'out' : 'in',
      timestamp: e.timestamp,
      remoteAgent: e.remoteAgent,
      remoteAgentName: e.remoteAgentName ?? e.remoteAgent?.slice(0, 8) ?? '(unknown)',
      text: e.text ?? '',
    });
  }
  return map;
}

function pickCounterparty(messages) {
  for (const m of messages) {
    if (m.direction === 'in') return { id: m.remoteAgent, name: m.remoteAgentName };
  }
  for (const m of messages) {
    if (m.direction === 'out') return { id: m.remoteAgent, name: m.remoteAgentName };
  }
  return { id: '(unknown)', name: '(unknown)' };
}

function buildTopicName(localAgent, remoteName, subject) {
  const baseSubject = (subject || 'thread').trim().replace(/\s+/g, ' ');
  const head = `${localAgent}↔${remoteName}`;
  const sep = ' — ';
  const remaining = TOPIC_NAME_MAX - head.length - sep.length;
  const trimmedSubject = remaining > 4 && baseSubject.length > remaining
    ? baseSubject.slice(0, remaining - 1) + '…'
    : baseSubject;
  return `${head}${sep}${trimmedSubject}`.slice(0, TOPIC_NAME_MAX);
}

function formatBackfillMessage(m, remoteAgent) {
  const arrow = m.direction === 'in' ? '📥' : '📤';
  const head = m.direction === 'in'
    ? `${arrow} ${m.remoteAgentName} → us`
    : `${arrow} us → ${m.remoteAgentName}`;
  const meta = m.timestamp ? `\n${m.timestamp}` : '';
  return `${head}${meta}\n${m.text}`;
}

function chunkBody(body) {
  if (body.length <= MAX_BODY_CHARS) return [body];
  const chunks = [];
  for (let i = 0; i < body.length; i += MAX_BODY_CHARS) {
    chunks.push(body.slice(i, i + MAX_BODY_CHARS));
  }
  return chunks;
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ');
}

async function createTopic(name) {
  const resp = await fetch(`${BASE}/telegram/topics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${AUTH}` },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`POST /telegram/topics ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function postToTopic(topicId, body) {
  const resp = await fetch(`${BASE}/telegram/post-update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${AUTH}` },
    body: JSON.stringify({ topicId, message: body, silent: true }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`POST /telegram/post-update ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
