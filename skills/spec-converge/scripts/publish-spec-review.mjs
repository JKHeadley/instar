#!/usr/bin/env node
/**
 * publish-spec-review.mjs — the sanctioned way to deliver a spec for review.
 *
 * Structure > Willpower: sending a spec for review WITHOUT a rendered,
 * verified ELI16 tunnel link should be impossible, not something the agent
 * remembers to attach. This script makes the correct delivery atomic:
 *
 *   1. Resolve the spec's ELI16 companion using the SAME convention the
 *      commit-time gate enforces (scripts/eli16-overview-check.mjs).
 *   2. Refuse if the ELI16 is missing or a stub (reuses checkEli16Overview).
 *   3. Render the ELI16 markdown as an auth-gated Private View (POST /view).
 *   4. VERIFY the tunnel link returns HTTP 200 before it is ever sent —
 *      never hand the operator a broken link.
 *   5. Compose the review message (rendered ELI16 link + full-spec PR link)
 *      and, with --send, deliver it via telegram-reply.sh.
 *
 * Usage:
 *   node skills/spec-converge/scripts/publish-spec-review.mjs \
 *     --spec docs/specs/FOO-SPEC.md \
 *     --pr https://github.com/JKHeadley/instar/pull/670 \
 *     --topic 12476 [--send]
 *
 * Auth: bearer API on port 4042 (NOT 4040 — that is dashboard/PIN auth),
 * token from the INSTAR_AUTH_TOKEN env var (config.json authToken is
 * externalized and will be rejected).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkEli16Overview } from '../../../scripts/eli16-overview-check.mjs';

export const API_PORT = Number(process.env.INSTAR_PORT) || 4042;

/** Relay locations, in resolution order (the second is the documented older-install path). */
const RELAY_RELATIVE_PATHS = ['.instar/scripts/telegram-reply.sh', '.claude/scripts/telegram-reply.sh'];

/**
 * Locate telegram-reply.sh by walking UP from `startDir`.
 *
 * It used to be spawned as the bare relative path `.instar/scripts/telegram-reply.sh`,
 * which only resolves when cwd IS the agent home. instar-dev work is REQUIRED to happen
 * in a worktree (docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md), and a worktree has no
 * `.instar/scripts/`, so every send from one failed with ENOENT. Walking up from a
 * worktree at `<agent-home>/.worktrees/<slug>` reaches `<agent-home>`, which has it.
 *
 * Returns an absolute path, or null when no relay exists above `startDir`.
 */
export function resolveRelayScript(startDir = process.cwd(), existsSync = fs.existsSync) {
  const envHome = process.env.INSTAR_AGENT_HOME;
  const roots = [];
  if (envHome) roots.push(path.resolve(envHome));
  let dir = path.resolve(startDir);
  for (;;) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of roots) {
    for (const rel of RELAY_RELATIVE_PATHS) {
      const candidate = path.join(root, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Did the relay actually deliver?
 *
 * The relay prints `Sent <n> chars to topic <id>` on a real send. Requiring that
 * marker — not merely a zero exit — is deliberate: this script's whole job is
 * handing the operator something to approve, and it previously printed
 * "[published] … delivered" straight after an ENOENT, so a dropped approval ask
 * was indistinguishable from a delivered one. Filed three times in fifteen days
 * (ACT-616 2026-07-13, ACT-1390 2026-07-27, ACT-1517 2026-07-28) before this fix.
 */
export function relayDelivered(result) {
  if (!result || result.error) return false;
  if (result.status !== 0) return false;
  return /Sent\s+\d+\s+chars?\s+to\s+topic/i.test(`${result.stdout || ''}${result.stderr || ''}`);
}

/** Split a spec file into its frontmatter body and the rest. */
export function extractFrontmatter(specText) {
  const m = specText.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

/** Pull a human title from the spec frontmatter (`title:`) or first H1. */
export function specTitle(specText, fallback) {
  const fm = extractFrontmatter(specText);
  const t = fm.match(/^\s*title\s*:\s*["']?([^"'\n]+)/m);
  if (t) return t[1].trim();
  const h1 = specText.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

/**
 * Compose the operator-facing review message. Pure — no I/O.
 * Leads with the rendered ELI16 link (what the operator reads first),
 * then the full-spec PR for the deep read.
 */
export function composeReviewMessage({ title, eli16Url, prUrl }) {
  const lines = [
    `Spec ready for your review: ${title}`,
    '',
    `ELI16 overview (rendered — tap to read): ${eli16Url}`,
  ];
  if (prUrl) lines.push(`Full spec + the decisions I need: ${prUrl}`);
  lines.push('', 'Nothing builds until you approve it.');
  return lines.join('\n');
}

/** POST the ELI16 markdown to /view; returns { tunnelUrl, localUrl, id }. */
async function createView({ title, markdown }) {
  const token = process.env.INSTAR_AUTH_TOKEN;
  if (!token) throw new Error('INSTAR_AUTH_TOKEN not set — cannot authenticate to the local API');
  const res = await fetch(`http://localhost:${API_PORT}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, markdown }),
  });
  if (!res.ok) throw new Error(`/view returned HTTP ${res.status} (${await res.text().catch(() => '')})`);
  const d = await res.json();
  if (!d.tunnelUrl) {
    throw new Error('view created but no tunnelUrl — is the tunnel running? (GET /tunnel)');
  }
  return d;
}

/** Verify a URL renders (HTTP 200) before it is ever sent to the operator. */
async function verifyUrl(url) {
  const res = await fetch(url, { method: 'GET' });
  return res.status;
}

function parseArgs(argv) {
  const out = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') out.spec = argv[++i];
    else if (a === '--pr') out.pr = argv[++i];
    else if (a === '--topic') out.topic = argv[++i];
    else if (a === '--send') out.send = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) {
    console.error('Usage: publish-spec-review.mjs --spec <path> --pr <url> --topic <id> [--send]');
    process.exit(2);
  }
  const specPath = path.resolve(args.spec);
  if (!fs.existsSync(specPath)) {
    console.error(`Spec not found: ${specPath}`);
    process.exit(2);
  }
  const specText = fs.readFileSync(specPath, 'utf8');
  const fm = extractFrontmatter(specText);

  // GATE: the ELI16 companion must exist and be non-stub (same convention as
  // the commit-time precommit gate). Refuse to publish without it.
  const eli16 = checkEli16Overview(specPath, fm);
  if (!eli16.ok) {
    console.error(`REFUSING to publish: ELI16 overview ${eli16.reason}.`);
    console.error(`  Expected sibling: ${eli16.siblingPath} (or a frontmatter \`eli16-overview:\` pointer).`);
    if (eli16.reason === 'too-short') {
      console.error(`  Found ${eli16.charCount} chars; need >= ${eli16.minChars}.`);
    }
    process.exit(1);
  }

  const title = specTitle(specText, path.basename(specPath, '.md'));
  const eli16Markdown = fs.readFileSync(eli16.eli16Path, 'utf8');

  // Render + verify the tunnel link BEFORE composing/sending.
  const view = await createView({ title: `${title} — ELI16`, markdown: eli16Markdown });
  const status = await verifyUrl(view.tunnelUrl);
  if (status !== 200) {
    console.error(`REFUSING to send: rendered ELI16 link did not verify (HTTP ${status}). No broken links.`);
    process.exit(1);
  }

  const message = composeReviewMessage({ title, eli16Url: view.tunnelUrl, prUrl: args.pr });

  if (args.send) {
    if (!args.topic) {
      console.error('--send requires --topic <id>');
      process.exit(2);
    }
    const relay = resolveRelayScript();
    if (!relay) {
      console.error(
        'REFUSING to claim delivery: no telegram-reply.sh found at or above this directory ' +
        `(looked for ${RELAY_RELATIVE_PATHS.join(' / ')}). The spec was NOT sent.`,
      );
      console.error('The composed message follows so the ask is not lost — send it yourself.');
      console.log(message);
      process.exit(1);
    }
    const reply = spawnSync('bash', [relay, String(args.topic)], {
      input: message, encoding: 'utf8',
    });
    process.stderr.write(reply.stdout || '');
    process.stderr.write(reply.stderr || '');
    if (!relayDelivered(reply)) {
      const why = reply.error
        ? reply.error.message
        : `relay exited ${reply.status} without a send confirmation`;
      console.error(`\n[NOT DELIVERED] the spec was NOT sent to topic ${args.topic}: ${why}`);
      console.error('The composed message follows so the ask is not lost — send it yourself.');
      console.log(message);
      process.exit(1);
    }
    console.error(`\n[published] ELI16 link verified (HTTP 200) and delivered to topic ${args.topic}.`);
  } else {
    // Print the message + the verified link for the caller to send.
    console.log(message);
    console.error(`\n[ok] ELI16 link verified (HTTP 200): ${view.tunnelUrl}`);
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`publish-spec-review failed: ${err.message}`);
    process.exit(1);
  });
}
