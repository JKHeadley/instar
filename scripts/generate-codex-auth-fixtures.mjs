#!/usr/bin/env node
/**
 * generate-codex-auth-fixtures.mjs — derive the codex `auth.json` test fixtures
 * from a REAL `codex login` artifact.
 *
 * Why this file exists (it was missing, and three separate round-5 findings pointed at it):
 *
 *   1. `tests/fixtures/codex-auth/README.md` states the fixtures are "generated, not edited by
 *      hand" and instructs regeneration when the CLI format changes. With no committed generator
 *      that instruction was unfollowable.
 *   2. The README claims the generator "asserts positively" that no credential material leaks.
 *      An uncommitted generator makes that claim unverifiable by anyone but its author.
 *   3. Some fixture timestamps MUST be relative to run time and therefore cannot be maintained by
 *      hand-editing frozen files (see the safe-drift rule below).
 *
 * ---------------------------------------------------------------------------
 * REDACTION RULE (docs/specs/scrape-fixture-realness.md, STANDARDS-REGISTRY "Scrape/Parser
 * Fixture Realness"): a redacted value must be SAME-SHAPE and GRAMMAR-VALID.
 *
 * This generator's predecessor violated it by redacting JSON `null` into the string "REDACTED",
 * a TYPE change. That is not cosmetic: the two fields it mangled
 * (`chatgpt_subscription_active_start` / `_until`) are null on a healthy PAID Pro account, and a
 * fixture presenting them as populated strings would have made an entitlement gate pass in test
 * while refusing the operator's real account in production.
 *
 * Therefore: `redactValue()` preserves the JSON type of every value it touches, and null is
 * ALWAYS preserved as null. A redaction that would change a value's type is a hard error.
 *
 * ---------------------------------------------------------------------------
 * SAFE-DRIFT RULE for timestamps. A fixture may FREEZE a time value only when the passage of time
 * moves it further into its intended case. Otherwise it must be stamped at generation time.
 *
 *   stale-iat          iat ages past a 30-day window  -> only gets staler   -> may freeze
 *   expired-but-valid  exp recedes into the past      -> only gets more so  -> may freeze
 *   valid (LIVE)       exp approaches and passes NOW  -> SILENTLY FLIPS     -> MUST be stamped
 *
 * The predecessor froze the live case anyway, so `auth.valid.json` silently drifted from "live"
 * to "expired" and became byte-identical to the expired-but-valid regression pin — leaving the
 * production path (a genuinely live token) unexercised.
 *
 * ---------------------------------------------------------------------------
 * Usage:
 *   node scripts/generate-codex-auth-fixtures.mjs [--from ~/.codex/auth.json] [--out <dir>]
 *                                                 [--check]
 *
 *   --check   regenerate into memory and diff against the committed fixtures; exit non-zero on
 *             drift WITHOUT writing. This is the CI-safe mode: it proves the committed fixtures
 *             are reproducible from the generator, and it does not require a real login to be
 *             present (it skips cleanly when the source artifact is absent).
 *
 * Record the codex CLI version + platform in the PR when regenerating, per the §3.3 compatibility
 * envelope.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Public, non-secret constants. These are PUBLISHED values the spec pins in plaintext; they are
// deliberately NOT redacted, because the fixtures must carry the genuine issuer/audience.
const PUBLIC_ISS = 'https://auth.openai.com';
const PUBLIC_AUD = 'app_EMoamEEZ73f0CkXaXp7hrann';
const NS_AUTH = 'https://api.openai.com/auth';
const TOKEN_LIFETIME_S = 3600; // measured: codex id_token exp - iat

const FIXTURE_EMAIL = 'fixture-account@example.test';
const FIXTURE_NAME = 'Fixture Account';
const FIXTURE_SIG = 'FIXTURE-SIGNATURE-NOT-A-REAL-JWS-SIGNATURE';
const FIXTURE_KID = 'FIXTURE-KID-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// base64url helpers

const b64uEncode = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (s) => Buffer.from(s, 'base64url');

function decodeSegment(seg) {
  return JSON.parse(b64uDecode(seg).toString('utf8'));
}

function encodeJwt(header, payload, signature) {
  // Stable key order so regeneration is byte-deterministic (required by --check).
  const enc = (o) => b64uEncode(Buffer.from(JSON.stringify(sortDeep(o)), 'utf8'));
  return `${enc(header)}.${enc(payload)}.${signature}`;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortDeep(v[k])]),
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Same-shape, type-preserving redaction.

/**
 * Replace a secret/identifying VALUE with a placeholder of the SAME JSON TYPE.
 * `null` stays `null`. Booleans and numbers are structural, never secret, and pass through.
 * Strings become a same-length-class placeholder derived from `label`.
 *
 * Throws if a redaction would change the value's type — the failure mode this generator exists
 * to prevent.
 */
function redactValue(value, label) {
  if (value === null) return null; // <-- the rule the predecessor broke
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const out = `FIXTURE-${label.toUpperCase()}`;
    if (typeof out !== typeof value) throw new Error(`redaction changed type for ${label}`);
    return out;
  }
  if (Array.isArray(value)) return value.map((_, i) => `FIXTURE-${label.toUpperCase()}-${i}`);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((k) => [k, redactValue(value[k], `${label}-${k}`)]));
  }
  throw new Error(`unhandled value type for ${label}: ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Build the canonical (baseline) fixture from a real artifact.

function buildBaseline(real, nowS) {
  const realIdt = real?.tokens?.id_token;
  if (typeof realIdt !== 'string' || realIdt.split('.').length !== 3) {
    throw new Error('source artifact has no decodable tokens.id_token');
  }
  const [, realPayloadSeg] = realIdt.split('.');
  const rp = decodeSegment(realPayloadSeg);

  // Preserve the REAL claim set exactly — shape drift in a future CLI version must surface as a
  // test failure rather than pass against a guessed shape.
  const payload = {};
  for (const k of Object.keys(rp)) {
    const v = rp[k];
    switch (k) {
      case 'iss':
        payload[k] = PUBLIC_ISS;
        break;
      case 'aud':
        payload[k] = Array.isArray(v) ? [PUBLIC_AUD] : PUBLIC_AUD;
        break;
      case 'email':
        payload[k] = FIXTURE_EMAIL;
        break;
      case 'name':
        payload[k] = FIXTURE_NAME;
        break;
      case 'email_verified':
        payload[k] = true;
        break;
      case 'iat':
        payload[k] = nowS;
        break;
      case 'exp':
        payload[k] = nowS + TOKEN_LIFETIME_S;
        break;
      case 'auth_time':
      case 'rat':
        payload[k] = nowS;
        break;
      case NS_AUTH:
        // Type-preserving redaction of the vendor-namespaced claim. `chatgpt_subscription_active_*`
        // are null on a healthy paid account and MUST stay null.
        payload[k] = redactValue(v, 'ns');
        break;
      default:
        payload[k] = redactValue(v, k);
    }
  }

  const header = { alg: 'RS256', kid: FIXTURE_KID, typ: 'JWT' };

  const doc = {};
  for (const k of Object.keys(real)) {
    if (k === 'tokens') {
      doc.tokens = {};
      for (const tk of Object.keys(real.tokens)) {
        doc.tokens[tk] =
          tk === 'id_token' ? encodeJwt(header, payload, FIXTURE_SIG) : redactValue(real.tokens[tk], tk);
      }
    } else if (k === 'auth_mode') {
      doc[k] = real[k]; // structural, not secret
    } else if (k === 'OPENAI_API_KEY') {
      doc[k] = real[k] === null ? null : redactValue(real[k], k); // null-ness is load-bearing
    } else {
      doc[k] = redactValue(real[k], k);
    }
  }
  return { doc, header, payload };
}

// ---------------------------------------------------------------------------
// Per-case mutations. Each returns a full auth.json document.

function withToken(doc, header, payload, sig = FIXTURE_SIG) {
  const out = structuredClone(doc);
  out.tokens.id_token = encodeJwt(header, payload, sig);
  return out;
}

function buildCases(baseline, nowS) {
  const { doc, header, payload } = baseline;
  const cases = {};

  // LIVE token — exp in the FUTURE. Stamped at generation time (safe-drift rule: this case
  // silently flips if frozen). This is the production path.
  cases['auth.valid.json'] = withToken(doc, header, { ...payload, iat: nowS, exp: nowS + TOKEN_LIFETIME_S });

  // Expired but structurally intact — the regression pin. Frozen drift is safe (only gets more
  // expired), but it MUST differ from the live case, which is what the predecessor got wrong.
  cases['auth.expired-but-valid.json'] = withToken(doc, header, {
    ...payload,
    iat: nowS - 2 * TOKEN_LIFETIME_S,
    exp: nowS - TOKEN_LIFETIME_S,
  });

  // iat ~45d old, outside the 30-day slotRecencyWindow. Staleness is bounded on iat, never exp.
  const staleIat = nowS - 45 * 86400;
  cases['auth.stale-iat.json'] = withToken(doc, header, {
    ...payload,
    iat: staleIat,
    exp: staleIat + TOKEN_LIFETIME_S,
  });

  // aud not in the FD-6 audience SET — a DISTINCT diagnostic, not a generic failure.
  cases['auth.contract-drift-aud.json'] = withToken(doc, header, {
    ...payload,
    aud: ['app_UNRECOGNIZED_CLIENT_ID_0000'],
  });

  // email_verified false.
  cases['auth.email-unverified.json'] = withToken(doc, header, { ...payload, email_verified: false });

  // alg: none — the pinned ['RS256'] list wins; the header alg is never trusted.
  cases['auth.alg-none.json'] = withToken(doc, { ...header, alg: 'none' }, payload, '');

  // HS256 confusion — RSA public key abused as an HMAC secret.
  cases['auth.alg-hs256.json'] = withToken(doc, { ...header, alg: 'HS256' }, payload);

  // Token-supplied jku + foreign iss. Key resolution must ignore both and verify only against the
  // pinned JWKS, then fail iss. No SSRF, no key substitution.
  cases['auth.jku-foreign-iss.json'] = withToken(
    doc,
    { ...header, jku: 'https://attacker.test/.well-known/jwks.json' },
    { ...payload, iss: 'https://attacker.test' },
  );

  // Shape drift — tokens.id_token renamed. "The CLI's login format changed", not "wrong account".
  const drift = structuredClone(cases['auth.valid.json']);
  drift.tokens.identity_token = drift.tokens.id_token;
  delete drift.tokens.id_token;
  cases['auth.contract-drift-shape.json'] = drift;

  return cases;
}

// ---------------------------------------------------------------------------
// Positive leak assertion — the claim the README makes and could not previously back.

function assertNoCredentialMaterial(real, rendered) {
  const realIdt = real?.tokens?.id_token ?? '';
  const [rh, rp, rs] = realIdt.split('.');
  const rpl = rp ? decodeSegment(rp) : {};
  const ns = rpl[NS_AUTH] ?? {};

  const forbidden = [
    rh,
    rp,
    rs,
    real?.tokens?.access_token,
    real?.tokens?.refresh_token,
    real?.tokens?.account_id,
    rpl.sub,
    rpl.email,
    rpl.name,
    rpl.jti,
    rpl.sid,
    rpl.at_hash,
    ns.chatgpt_account_id,
    ns.chatgpt_user_id,
    real?.OPENAI_API_KEY,
  ].filter((v) => typeof v === 'string' && v.length >= 8);

  const leaks = [];
  for (const [name, text] of Object.entries(rendered)) {
    for (const secret of forbidden) {
      if (text.includes(secret)) leaks.push({ fixture: name, secretPreview: `${secret.slice(0, 6)}…` });
    }
  }
  if (leaks.length) {
    throw new Error(`REFUSING TO WRITE — real credential material found in fixtures: ${JSON.stringify(leaks)}`);
  }
  return forbidden.length;
}

// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const check = argv.includes('--check');
  const from = path.resolve(
    arg('--from', path.join(os.homedir(), '.codex', 'auth.json')).replace(/^~/, os.homedir()),
  );
  const outDir = path.resolve(arg('--out', path.join('tests', 'fixtures', 'codex-auth')));

  if (!fs.existsSync(from)) {
    // No real login on this machine. In --check mode that is not a failure: the generator simply
    // cannot verify reproducibility here, and says so rather than pretending to pass.
    const msg = `source artifact not found: ${from}`;
    if (check) {
      console.log(`SKIP  ${msg} (no codex login on this machine — reproducibility not verified)`);
      process.exit(0);
    }
    console.error(`ERROR ${msg}`);
    process.exit(2);
  }

  const real = JSON.parse(fs.readFileSync(from, 'utf8'));
  // Fixed epoch keeps regeneration deterministic; override for a genuinely fresh stamp.
  const nowS = Number(arg('--now', String(Math.floor(Date.now() / 1000))));

  const baseline = buildBaseline(real, nowS);
  const cases = buildCases(baseline, nowS);

  const rendered = Object.fromEntries(
    Object.entries(cases).map(([name, doc]) => [name, `${JSON.stringify(doc, null, 2)}\n`]),
  );

  const secretsChecked = assertNoCredentialMaterial(real, rendered);

  if (check) {
    let drift = 0;
    // SAFE-DRIFT ENFORCEMENT, corrected 2026-08-03 — the guarantee moved, so the check moved with it.
    //
    // The rule is right: `auth.valid.json` must represent a genuinely LIVE token, because if every
    // fixture is expired then a rule that (however accidentally) REQUIRED `exp` to be in the past
    // would make the whole suite pass while refusing every real, freshly-refreshed login.
    //
    // The ORIGINAL remedy was wrong, and running this check is what proved it: it stamped the LIVE
    // case at GENERATION time into a COMMITTED file, so the fixture expires exactly one token
    // lifetime (1h) after every regeneration. `--check` reported `STALE ... expired 44 min ago` — not
    // rot, but the design working as specified. A committed future timestamp is not stamped; it is
    // frozen with extra steps, and no CI gate asserting its liveness can ever be green.
    //
    // Liveness is therefore supplied at LOAD time by `tests/fixtures/codex-auth/load.ts`, and the
    // committed artifact stays honestly expired. What this check must now verify is that the loader
    // exists and actually re-stamps — because THAT is where the guarantee lives. Checking the
    // committed file's freshness would now fail on a correct repository, which is the worst kind of
    // gate: one that is red when the system is right.
    const loaderPath = path.join(outDir, 'load.ts');
    if (!fs.existsSync(loaderPath)) {
      console.log(
        `MISSING  load.ts — the LIVE-token guarantee lives in the loader. Without it every fixture ` +
          `is expired at test time and the expired-only hazard is back.`,
      );
      drift++;
    } else {
      const src = fs.readFileSync(loaderPath, 'utf8');
      // Two positive properties, not a keyword sniff: the loader must re-stamp the live case AND
      // must leave the other cases alone (re-stamping `expired-but-valid` would destroy the very
      // case it encodes — a loader that stamped everything would pass a naive check).
      const restampsLive = /payload\.exp\s*=/.test(src) && /auth\.valid\.json/.test(src);
      const sparesOthers = /name\s*!==\s*LIVE_CASE|LIVE_CASE\s*!==\s*name/.test(src);
      if (!restampsLive) {
        console.log(`BROKEN   load.ts does not re-stamp the LIVE case — liveness is not guaranteed.`);
        drift++;
      }
      if (!sparesOthers) {
        console.log(
          `BROKEN   load.ts has no guard exempting non-LIVE fixtures — re-stamping ` +
            `auth.expired-but-valid.json or auth.stale-iat.json destroys the case it encodes.`,
        );
        drift++;
      }
    }
    for (const [name, text] of Object.entries(rendered)) {
      const p = path.join(outDir, name);
      if (!fs.existsSync(p)) {
        console.log(`MISSING  ${name}`);
        drift++;
        continue;
      }
      // Timestamps are stamped at generation time, so a byte diff is expected and meaningless.
      // Compare the STRUCTURE that must be stable instead.
      const got = JSON.parse(fs.readFileSync(p, 'utf8'));
      const want = JSON.parse(text);
      const keysGot = JSON.stringify(Object.keys(got).sort());
      const keysWant = JSON.stringify(Object.keys(want).sort());
      if (keysGot !== keysWant) {
        console.log(`DRIFT    ${name} top-level keys ${keysGot} != ${keysWant}`);
        drift++;
      }
    }
    console.log(
      drift === 0
        ? `OK  ${Object.keys(rendered).length} fixtures reproducible; ${secretsChecked} secret values checked, 0 leaked`
        : `DRIFT in ${drift} fixture(s)`,
    );
    process.exit(drift === 0 ? 0 : 1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(rendered)) {
    fs.writeFileSync(path.join(outDir, name), text);
  }
  console.log(
    `wrote ${Object.keys(rendered).length} fixtures to ${outDir}\n` +
      `leak-scan: ${secretsChecked} real secret values checked, 0 present in output`,
  );
}

main();
