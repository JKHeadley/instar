// safe-git-allow: read-only; this script performs no git operations at all.
/**
 * refresh-carrier-ledger — regenerate docs/specs/carriers/<slug>.json from the
 * live commitment registry.
 *
 * WHY A CHECKED-IN LEDGER. The deferral lint verifies that a marker's carrier
 * is CHECKABLE by requiring its immutable text inlined in the spec. A reviewer
 * defeated that by typing one: an invented `**CMT-999999** — "…"` blockquote
 * passed with exit 0 while the API returns "not found" for that id. Prose a
 * human authors cannot establish that a commitment exists; only something
 * generated from the registry can.
 *
 * So existence is checked against this ledger, and coverage remains a reviewer
 * duty (see the lint's header for the measurements showing why no similarity
 * metric was shippable).
 *
 * Usage: node scripts/refresh-carrier-ledger.mjs <slug> CMT-1317 CMT-1319 …
 *   env: INSTAR_AUTH_TOKEN, and optionally INSTAR_PORT (default 4042)
 *
 * The ledger is a SNAPSHOT, deliberately: it records what the registry said
 * when it was generated, so a reader can tell a stale ledger from a current
 * one by its timestamp rather than trusting it silently.
 */
import fs from 'node:fs';
import path from 'node:path';

const [slug, ...ids] = process.argv.slice(2);
if (!slug || ids.length === 0) {
  console.error('Usage: node scripts/refresh-carrier-ledger.mjs <slug> CMT-#### [CMT-#### …]');
  process.exit(1);
}
const port = process.env.INSTAR_PORT ?? '4042';
const token = process.env.INSTAR_AUTH_TOKEN;
if (!token) {
  console.error('INSTAR_AUTH_TOKEN is required — refusing to write a ledger from unauthenticated reads.');
  process.exit(1);
}

const out = { generatedAt: new Date().toISOString(), slug, carriers: {} };
let missing = 0;
for (const id of ids) {
  const res = await fetch(`http://localhost:${port}/commitments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`  ${id}: HTTP ${res.status} — NOT written to the ledger`);
    missing++;
    continue;
  }
  const body = await res.json();
  const c = body.commitment ?? body;
  out.carriers[id] = {
    status: c.status ?? null,
    owner: c.owner ?? null,
    blockedOn: c.blockedOn ?? null,
    excerpt: String(c.agentResponse ?? '').slice(0, 400),
  };
}

const dir = 'docs/specs/carriers';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${slug}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(`carrier ledger: ${Object.keys(out.carriers).length} written, ${missing} unresolved`);
// A missing id is a real signal — the spec references a carrier the registry
// does not have — so it must not exit 0 and read as success.
if (missing > 0) process.exit(1);
