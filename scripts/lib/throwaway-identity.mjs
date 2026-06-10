/**
 * throwaway-identity.mjs — mint genuinely-distinct, readable throwaway email
 * identities for live-integration test harnesses (Slack, Discord, …).
 *
 * Backed by the mail.tm public disposable-mailbox API. Each minted inbox is a
 * real, distinct, readable address — so a live test can use N of them as N
 * GENUINELY DISTINCT principals (distinct addresses → distinct provider user
 * IDs) with ZERO real accounts. This is the autonomous half of the
 * test-identity provisioning the Live Integration Security-Test Harness needs;
 * the only step it does NOT cover is an anti-bot signup CAPTCHA at workspace/
 * account creation, which is a deliberate human-verification control (see
 * docs/specs/JUDGMENT-PERMISSION-LIVE-RUN-RUNBOOK.md).
 *
 * Pure helpers (extractCode/extractLink/matchMessage) and HTTP helpers with an
 * injectable `fetchImpl` so the unit test runs fully hermetic (no network).
 *
 * CLI: scripts/throwaway-identity.mjs (mint | wait). This file is the importable
 * library; the CLI is a thin wrapper.
 */

const DEFAULT_API_BASE = 'https://api.mail.tm';

/** Extract the first verification code (default: a 6-digit run) from a message body. */
export function extractCode(text, { pattern = /\b(\d{6})\b/ } = {}) {
  if (typeof text !== 'string') return null;
  const m = text.match(pattern);
  return m ? (m[1] ?? m[0]) : null;
}

/** Extract the first URL (optionally matching a substring/regex) from a message body. */
export function extractLink(text, { match } = {}) {
  if (typeof text !== 'string') return null;
  const urls = text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  if (!match) return urls[0] ?? null;
  const test = match instanceof RegExp ? (u) => match.test(u) : (u) => u.includes(match);
  return urls.find(test) ?? null;
}

/** Does a mail.tm message summary match the caller's filter (subject/from substring or regex)? */
export function matchMessage(msg, { subject, from } = {}) {
  if (!msg) return false;
  const subjOk = matchField(msg.subject, subject);
  const fromAddr = (msg.from && (msg.from.address || msg.from.name)) || '';
  const fromOk = matchField(fromAddr, from);
  return subjOk && fromOk;
}

function matchField(value, filter) {
  if (filter === undefined || filter === null) return true;
  const v = String(value ?? '');
  return filter instanceof RegExp ? filter.test(v) : v.toLowerCase().includes(String(filter).toLowerCase());
}

function memberArray(json) {
  // mail.tm is a Hydra/JSON-LD API: collections live under "hydra:member".
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json['hydra:member'])) return json['hydra:member'];
  return [];
}

async function jsonFetch(fetchImpl, url, opts) {
  const res = await fetchImpl(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const detail = (body && (body['hydra:description'] || body.message || body.detail)) || text.slice(0, 200);
    throw new Error(`mail.tm ${opts?.method || 'GET'} ${url} → ${res.status}: ${detail}`);
  }
  return body;
}

/**
 * Mint a fresh throwaway inbox: pick a domain, create the account, get a token.
 * Returns { address, password, token, accountId }. `rand` is injectable so the
 * test is deterministic and the script never calls Math.random in a workflow.
 */
export async function createInbox({
  fetchImpl = fetch,
  apiBase = DEFAULT_API_BASE,
  localPart,
  rand = () => Math.floor(Math.random() * 1e10).toString(36),
} = {}) {
  const domains = memberArray(await jsonFetch(fetchImpl, `${apiBase}/domains`));
  const domain = domains.find((d) => d.isActive !== false)?.domain || domains[0]?.domain;
  if (!domain) throw new Error('mail.tm: no available domain');
  const local = localPart || `echo-${rand()}`;
  const address = `${local}@${domain}`;
  const password = `Echo!${rand()}A9`;
  const account = await jsonFetch(fetchImpl, `${apiBase}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tokenResp = await jsonFetch(fetchImpl, `${apiBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!tokenResp?.token) throw new Error('mail.tm: token request returned no token');
  return { address, password, token: tokenResp.token, accountId: account?.id ?? null };
}

/** List message summaries in the inbox (most-recent first, per mail.tm). */
export async function listMessages(token, { fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
  const body = await jsonFetch(fetchImpl, `${apiBase}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return memberArray(body);
}

/** Fetch one message's full body (text + html). */
export async function getMessage(token, id, { fetchImpl = fetch, apiBase = DEFAULT_API_BASE } = {}) {
  return jsonFetch(fetchImpl, `${apiBase}/messages/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Poll the inbox until a message matches the filter, then return its full body.
 * `sleep` and `now` are injectable so the test runs without real timers/clock.
 * Throws on timeout. Returns the full message (with .text / .html / .subject).
 */
export async function waitForMessage(token, {
  subject,
  from,
  timeoutMs = 120_000,
  intervalMs = 3_000,
  fetchImpl = fetch,
  apiBase = DEFAULT_API_BASE,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  // First iteration runs immediately (no upfront sleep).
  for (let first = true; ; first = false) {
    if (!first) {
      if (now() >= deadline) {
        throw new Error(`waitForMessage: timed out after ${timeoutMs}ms (subject=${subject ?? '*'} from=${from ?? '*'})`);
      }
      await sleep(intervalMs);
    }
    const summaries = await listMessages(token, { fetchImpl, apiBase });
    const hit = summaries.find((m) => matchMessage(m, { subject, from }));
    if (hit) return getMessage(token, hit.id, { fetchImpl, apiBase });
    if (first && now() >= deadline) {
      throw new Error(`waitForMessage: timed out after ${timeoutMs}ms (subject=${subject ?? '*'} from=${from ?? '*'})`);
    }
  }
}
