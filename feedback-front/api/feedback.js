// ../src/feedback-factory/receiver/defense.ts
import { createHmac, timingSafeEqual } from "node:crypto";
var SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
var RATE_LIMITS = {
  perHour: 10,
  perDay: 50,
  windowHourMs: 60 * 60 * 1e3,
  windowDayMs: 24 * 60 * 60 * 1e3
};
function normalizeWebhookSecret(secret) {
  return secret == null ? secret : secret.trim();
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

// src/feedback.ts
function headerStr(v) {
  return Array.isArray(v) ? v[0] : v;
}
function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method-not-allowed", phase: 0 });
    return;
  }
  const secret = normalizeWebhookSecret(process.env.INSTAR_WEBHOOK_SECRET);
  if (!secret) {
    res.status(503).json({ error: "receiver-not-configured", phase: 0 });
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
