// ../src/feedback-factory/receiver/defense.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var VALID_TYPES = ["bug", "feature", "improvement", "question", "hallucination", "other"];
var SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
var FEEDBACK_ID_RE = /^fb-[a-z0-9-]{6,36}$/;
var AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,98}[a-zA-Z0-9]$/;
var NODE_VERSION_RE = /^v?\d+\.\d+\.\d+$/;
var RATE_LIMITS = {
  perHour: 10,
  perDay: 50,
  windowHourMs: 60 * 60 * 1e3,
  windowDayMs: 24 * 60 * 60 * 1e3
};
function normalizeWebhookSecret(secret) {
  return secret == null ? secret : secret.trim();
}
function isValidType(type) {
  return typeof type === "string" && VALID_TYPES.includes(type);
}
function extractSourceIp(headers, remoteAddress) {
  const xff = headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  return xffStr?.split(",")[0]?.trim() || remoteAddress || "unknown";
}
function validateAgentFingerprint(userAgent, headerVersion) {
  const ua = userAgent || "";
  if (!ua.toLowerCase().includes("instar/")) {
    return { valid: false, reason: "missing-ua" };
  }
  if (headerVersion && !SEMVER_RE.test(headerVersion)) {
    return { valid: false, reason: "invalid-version-header" };
  }
  return { valid: true };
}
function checkHoneypot(body) {
  return Boolean(body.website || body.email);
}
function verifySignature(args) {
  const { signature, timestamp, body, secret, now } = args;
  if (!signature || !timestamp || !secret) return false;
  const age = now - parseInt(timestamp, 10);
  if (isNaN(age) || age > 3e5 || age < -6e4) return false;
  const payload = `${timestamp}.${JSON.stringify(body)}`;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(new Uint8Array(sigBuf), new Uint8Array(expBuf));
  } catch {
    return false;
  }
}
var RateLimiter = class {
  constructor(limits = RATE_LIMITS, now = () => Date.now()) {
    this.limits = limits;
    this.now = now;
  }
  store = /* @__PURE__ */ new Map();
  lastPrune = 0;
  pruneIntervalMs = 10 * 60 * 1e3;
  prune() {
    const now = this.now();
    if (now - this.lastPrune < this.pruneIntervalMs) return;
    this.lastPrune = now;
    const cutoff = now - this.limits.windowDayMs;
    this.store.forEach((entry, key) => {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) this.store.delete(key);
    });
  }
  check(ip) {
    this.prune();
    const now = this.now();
    const entry = this.store.get(ip) || { timestamps: [] };
    const hourAgo = now - this.limits.windowHourMs;
    const dayAgo = now - this.limits.windowDayMs;
    const hourCount = entry.timestamps.filter((t) => t > hourAgo).length;
    const dayCount = entry.timestamps.filter((t) => t > dayAgo).length;
    if (hourCount >= this.limits.perHour) {
      const oldest = entry.timestamps.filter((t) => t > hourAgo).sort()[0];
      return { allowed: false, retryAfterSec: Math.ceil((oldest + this.limits.windowHourMs - now) / 1e3) };
    }
    if (dayCount >= this.limits.perDay) {
      const oldest = entry.timestamps.filter((t) => t > dayAgo).sort()[0];
      return { allowed: false, retryAfterSec: Math.ceil((oldest + this.limits.windowDayMs - now) / 1e3) };
    }
    entry.timestamps.push(now);
    this.store.set(ip, entry);
    return { allowed: true };
  }
};

// ../src/feedback-factory/receiver/handlers.ts
function header(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function defaultFeedbackId(now) {
  return `fb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
async function handleFeedbackSubmit(req, deps) {
  const { store, rateLimiter: rateLimiter2, secret, now } = deps;
  const sourceIp = extractSourceIp(req.headers, req.remoteAddress);
  const rate = rateLimiter2.check(sourceIp);
  if (!rate.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSec) },
      json: { error: "Rate limit exceeded", retryAfterSec: rate.retryAfterSec }
    };
  }
  const fp = validateAgentFingerprint(header(req.headers, "user-agent"), header(req.headers, "x-instar-version"));
  if (!fp.valid) {
    return { status: 400, json: { error: "Invalid request format" } };
  }
  const body = req.body ?? {};
  if (checkHoneypot(body)) {
    return { status: 200, json: { id: "fb-received", received: true } };
  }
  const verified = verifySignature({
    signature: header(req.headers, "x-instar-signature"),
    timestamp: header(req.headers, "x-instar-timestamp"),
    body: req.body,
    secret,
    now
  });
  if (!req.body || typeof req.body !== "object") {
    return { status: 400, json: { error: "Request body must be JSON" } };
  }
  const title = body.title;
  if (!title || typeof title !== "string" || title.trim().length < 3) {
    return { status: 400, json: { error: "title is required (min 3 characters)" } };
  }
  const description = body.description;
  if (!description || typeof description !== "string" || description.trim().length < 10) {
    return { status: 400, json: { error: "description is required (min 10 characters)" } };
  }
  const type = body.type && isValidType(body.type) ? body.type : "other";
  if (body.agentName && !AGENT_NAME_RE.test(body.agentName)) {
    return { status: 400, json: { error: "Invalid agentName format" } };
  }
  if (body.instarVersion && !SEMVER_RE.test(body.instarVersion)) {
    return { status: 400, json: { error: "Invalid instarVersion format (expected semver)" } };
  }
  if (body.nodeVersion && !NODE_VERSION_RE.test(body.nodeVersion)) {
    return { status: 400, json: { error: "Invalid nodeVersion format" } };
  }
  const provided = body.feedbackId;
  const feedbackId = typeof provided === "string" && FEEDBACK_ID_RE.test(provided) ? provided : (deps.generateFeedbackId ?? (() => defaultFeedbackId(now)))();
  if (await store.hasFeedback(feedbackId)) {
    return { status: 200, json: { id: feedbackId, received: true, duplicate: true } };
  }
  await store.addFeedback({
    feedbackId,
    type,
    title: title.trim().slice(0, 500),
    description: description.trim().slice(0, 1e4),
    agentName: (body.agentName || "unknown").slice(0, 100),
    instarVersion: (body.instarVersion || "unknown").slice(0, 20),
    nodeVersion: (body.nodeVersion || "unknown").slice(0, 20),
    os: (body.os || "unknown").slice(0, 100),
    context: typeof body.context === "string" ? body.context.slice(0, 5e3) : void 0,
    sourceIp,
    verified
  });
  return { status: 200, json: { id: feedbackId, received: true } };
}

// ../src/feedback-factory/receiver/BlobInboxStore.ts
var INBOX_PREFIX = "inbox/";
var BlobInboxStore = class {
  constructor(client, clock = () => (/* @__PURE__ */ new Date()).toISOString()) {
    this.client = client;
    this.clock = clock;
  }
  async hasFeedback(feedbackId) {
    const page = await this.client.list(`${INBOX_PREFIX}${feedbackId}`, { limit: 1 });
    return page.blobs.length > 0;
  }
  async addFeedback(item) {
    const row = { receivedAt: this.clock(), status: "unprocessed", ...item };
    await this.client.put(`${INBOX_PREFIX}${item.feedbackId}.json`, JSON.stringify(row));
  }
};

// ../src/feedback-factory/inbox/BlobInboxClient.ts
var DEFAULT_API_BASE = "https://blob.vercel-storage.com";
var API_VERSION = "7";
var BlobApiError = class extends Error {
  constructor(status, operation, detail) {
    super(`blob ${operation} failed: HTTP ${status} \u2014 ${detail}`);
    this.status = status;
    this.operation = operation;
    this.name = "BlobApiError";
  }
};
var BlobInboxClient = class {
  token;
  apiBase;
  fetchImpl;
  constructor(opts) {
    if (!opts.token) throw new Error("BlobInboxClient requires a token");
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.token}`,
      "x-api-version": API_VERSION,
      ...extra
    };
  }
  /** Durably store one inbox object. Returns the blob's (random-suffixed) URL + pathname. */
  async put(pathname, content) {
    const res = await this.fetchImpl(`${this.apiBase}/${pathname}`, {
      method: "PUT",
      headers: this.headers({
        "x-content-type": "application/json",
        "x-add-random-suffix": "1"
      }),
      body: content
    });
    if (!res.ok) throw new BlobApiError(res.status, "put", await safeText(res));
    const json = await res.json();
    return { url: json.url, pathname: json.pathname };
  }
  /** List one page of blobs under a prefix (oldest pagination order is the API's). */
  async list(prefix, opts = {}) {
    const params = new URLSearchParams({ prefix });
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const res = await this.fetchImpl(`${this.apiBase}/?${params.toString()}`, {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok) throw new BlobApiError(res.status, "list", await safeText(res));
    const json = await res.json();
    return { blobs: json.blobs ?? [], cursor: json.cursor, hasMore: Boolean(json.hasMore) };
  }
  /** Read a blob's content by its URL (the URL came from put/list — never predicted). */
  async fetchContent(url) {
    const res = await this.fetchImpl(url, { method: "GET" });
    if (!res.ok) throw new BlobApiError(res.status, "fetchContent", await safeText(res));
    return res.text();
  }
  /** Delete blobs by URL. Idempotent server-side (deleting a gone blob is not an error). */
  async del(urls) {
    if (urls.length === 0) return;
    const res = await this.fetchImpl(`${this.apiBase}/delete`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ urls })
    });
    if (!res.ok) throw new BlobApiError(res.status, "del", await safeText(res));
  }
};
async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}

// src/feedback.ts
function headerStr(v) {
  return Array.isArray(v) ? v[0] : v;
}
var rateLimiter = new RateLimiter();
function inboxToken() {
  return process.env.FEEDBACK_INBOX_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN || void 0;
}
async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method-not-allowed", phase: 0 });
    return;
  }
  const secret = normalizeWebhookSecret(process.env.INSTAR_WEBHOOK_SECRET);
  if (!secret) {
    res.status(503).json({ error: "receiver-not-configured", phase: 0 });
    return;
  }
  const token = inboxToken();
  if (token) {
    const store = new BlobInboxStore(
      new BlobInboxClient({ token, apiBase: process.env.FEEDBACK_INBOX_BLOB_API_BASE })
    );
    const out = await handleFeedbackSubmit(
      {
        headers: req.headers,
        body: req.body,
        remoteAddress: req.socket?.remoteAddress
      },
      { store, rateLimiter, secret, now: Date.now() }
    );
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    res.status(out.status).json(out.json);
    return;
  }
  const ua = headerStr(req.headers["user-agent"]);
  const version = headerStr(req.headers["x-instar-version"]);
  const fp = validateAgentFingerprint(ua, version);
  if (!fp.valid) {
    res.status(403).json({ error: "invalid-agent", reason: fp.reason, phase: 0 });
    return;
  }
  const body = req.body ?? {};
  if (checkHoneypot(body)) {
    res.status(200).json({ ok: true, phase: 0, accepted: false });
    return;
  }
  const ok = verifySignature({
    signature: headerStr(req.headers["x-instar-signature"]),
    timestamp: headerStr(req.headers["x-instar-timestamp"]),
    body,
    secret,
    now: Date.now()
  });
  if (!ok) {
    res.status(401).json({ error: "invalid-signature", phase: 0 });
    return;
  }
  res.status(200).json({ ok: true, phase: 0, accepted: true, note: "phase-0 verify-only; no persistence" });
}
export {
  handler as default
};
