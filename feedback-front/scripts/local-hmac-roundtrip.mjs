// Local Phase-0 proof: a correctly-signed request round-trips through the BUNDLED front
// handler (which carries the canonical verifySignature). Run after `npm run build`.
// Proves the wiring (env secret normalization, header extraction, HMAC verify) end-to-end
// without needing a deploy. No persistence is exercised (Phase-0).
import { createHmac } from 'node:crypto';

const SECRET = 'local-test-secret\n'; // trailing newline on purpose — normalizeWebhookSecret must trim it
process.env.INSTAR_WEBHOOK_SECRET = SECRET;

const { default: handler } = await import('../api/feedback.js');

function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
}
function sign(body, ts, secret) {
  return createHmac('sha256', secret.trim()).update(`${ts}.${JSON.stringify(body)}`).digest('hex');
}
function call(reqOverrides) {
  const res = mockRes();
  handler({ method: 'POST', headers: {}, body: {}, ...reqOverrides }, res);
  return res;
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✕ ${name}`); } };

const body = { message: 'phase-0 round-trip', type: 'bug' };
const ts = Date.now().toString();
const goodSig = sign(body, ts, SECRET);

// 1. Valid signature (with a trailing-newline secret) → 200 accepted:true
let r = call({ headers: { 'user-agent': 'instar/1.2.3', 'x-instar-signature': goodSig, 'x-instar-timestamp': ts }, body });
check('valid signature → 200 accepted (trailing-newline secret trimmed)', r.code === 200 && r.body?.accepted === true);

// 2. Bad signature → 401
r = call({ headers: { 'user-agent': 'instar/1.2.3', 'x-instar-signature': 'deadbeef', 'x-instar-timestamp': ts }, body });
check('bad signature → 401', r.code === 401);

// 3. Missing instar UA → 403
r = call({ headers: { 'x-instar-signature': goodSig, 'x-instar-timestamp': ts }, body });
check('missing instar/ UA → 403', r.code === 403);

// 4. Honeypot (email field present) → 200 accepted:false (never reveals the trap)
const hpBody = { ...body, email: 'bot@spam.com' };
r = call({ headers: { 'user-agent': 'instar/1.2.3', 'x-instar-signature': sign(hpBody, ts, SECRET), 'x-instar-timestamp': ts }, body: hpBody });
check('honeypot → 200 accepted:false', r.code === 200 && r.body?.accepted === false);

// 5. Stale timestamp (>5min) → 401 (replay window)
const stale = (Date.now() - 6 * 60 * 1000).toString();
r = call({ headers: { 'user-agent': 'instar/1.2.3', 'x-instar-signature': sign(body, stale, SECRET), 'x-instar-timestamp': stale }, body });
check('stale timestamp (>5min) → 401', r.code === 401);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
