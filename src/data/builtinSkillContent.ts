/**
 * builtinSkillContent.ts — single source for built-in skill content that BOTH
 * the scaffold path (`installBuiltinSkills` in init.ts) AND the PostUpdateMigrator
 * skill-content migration consume, so the two cannot drift (Integration-R2 M3 /
 * lessons-aware M1: init.ts previously carried an inline copy that diverged from
 * the repo SKILL.md, so new agents scaffolded stale content forever).
 */

export const ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT = `---
name: iterative-converging-audit
description: Run any "find all instances of X" sweep — security audit, safety audit, code review, research, compliance check — as an iterative loop that does NOT stop at one pass. Audit, fix, RE-audit, repeat until a clean pass returns zero new discoveries. Trigger words: audit, sweep, find all, review everything, comprehensive, thorough, exhaustive, security review, did we get everything, convergence.
metadata:
  user_invocable: "true"
---
<!-- INSTAR:AUDIT-META-ARTIFACT-V2 -->

# /iterative-converging-audit

A single audit pass is never thorough. The first sweep has blind spots; the fixes themselves reveal or introduce new instances; and "I looked once and stopped finding things" usually means "I got tired," not "there is nothing left." The only honest definition of a complete audit is a CONVERGED one: a re-run that finds zero new discoveries. This enforces the "Iterative Audit to Convergence" constitution standard (docs/STANDARDS-REGISTRY.md). It applies to ANY find-all task — security audits, safety audits, code reviews, research sweeps, compliance checks, dead-code hunts.

## When to use
- Any "find all", "audit", "sweep", "review everything", "make sure we got everything".
- After fixing a bug, when the same class likely exists elsewhere ("where else do we do this?").
- A security/safety audit where a missed instance is dangerous.
- Whenever you catch yourself about to say "I checked, looks clean" after ONE pass.

## The loop (do not skip steps)
0. FRAME — write down: the target pattern (be precise), the search surface (where instances could live — your first list is always incomplete), the classification buckets, the fix policy per bucket, and the convergence criterion (usually: a full re-sweep finds nothing not already in the ledger).
1. AUDIT (round N) — sweep the surface; record EVERY finding with location + behavior + bucket. Cast wide (false positives are cheap to classify out; missed instances are the failure mode). Use multiple search angles — by-name AND by-content AND by-structure; one angle is blind to what the others catch.
2. FIX — remediate each finding, OR classify it accepted with a written reason (an accepted finding is a DECISION, not a TODO). Fixing changes the code, which is exactly why you must re-audit.
3. RE-AUDIT (round N+1) — sweep the FULL surface again, not just what you touched. Your surface grew (round N taught you new places), and the fixes may have moved or masked instances. New findings -> back to step 2. Zero new -> CONVERGED.
4. DECLARE convergence honestly — "Converged after K rounds; round K found nothing new. Ledger: X total, Y fixed, Z accepted-advisory (each with a reason)." If you stopped for time/budget/patience, say INCOMPLETE — never dress up an exhausted audit as a thorough one. In a repo carrying scripts/write-audit-convergence.mjs (the instar source tree, or any repo vendoring it), the converged claim is EARNED not asserted: write the canonical report at docs/audits/<slug>.md and run "node scripts/write-audit-convergence.mjs --audit docs/audits/<slug>.md"; the validator refuses the stamp unless the ledger and the blind-spot/standards artifact genuinely earn it, and a hand-typed converged: is rejected at commit and re-checked in CI. Elsewhere, still write the canonical report — never fabricate a stamp you cannot earn.
5. STANDING GUARD — where the pattern is CI-expressible, leave a ratchet (a no-* test) so the audit cannot silently un-converge on the next commit. The accepted-findings ledger becomes its allowlist. Name it in the report's standing-guard: field (or record a closed-enum exemption: non-ci-expressible | external-system | one-time-human-review with a real rationale).

## The ledger (the durable artifact) — canonical at docs/audits/<slug>.md
Every converged audit owes TWO artifacts: (1) the finding-by-finding fix/classification path and (2) the reusable blind-spot lesson. Before Round 1, add exactly one "## Meta-insight" section with "How it arose:" and "Why prior controls missed it:" causal lines. Frontmatter names blind-spot-class plus standard-response-kind (created | amended | no-change), standard-response-ref, stable standard-response-article-id, exact standard-response-article, and standard-response-rationale. no-change is the honest answer when the existing standard already covered the class; it never waives the lesson. The stamp tool writes the digest/timestamp fields — never hand-author them.

The ledger IS a report at docs/audits/<slug>.md: frontmatter (audit, target-pattern, search-surface, converged [validator-stamped only], standing-guard XOR exemption, blind-spot class, complete standards response) + one Meta-insight section + one "## Round N" section per pass, each recording the search angles run, the surface delta, a findings table (location | behavior | bucket | disposition, where disposition is fixed:<ref> | accepted:<reason> | deferred:<ref>), and a "New findings this round: <count>" line. Reference each finding by path+line — NEVER paste secret/credential material into the ledger (the commit gate scans audit reports and blocks). It makes "converged after K rounds" a machine-verifiable claim instead of a feeling; the new-findings-per-round count falling to zero is the convergence signal.

## Anti-patterns this forbids
- "I checked, looks clean" (one pass) — round 1 always has blind spots; re-audit at least once.
- "Fixed the 3 I found, done" — fixes reveal/create new instances; re-sweep AFTER fixing.
- Re-auditing only what you touched — new instances hide in untouched code; re-sweep the FULL surface.
- An accepted finding treated as a TODO — it rots silently; every accepted finding carries a written reason.
- Calling it "thorough" when you stopped for time/budget — say "incomplete", never dress it up.
- One search angle — each angle is blind to what the others catch.

The principle: thoroughness is not how hard you looked once — it is whether a fresh look finds anything new. Audit until the fresh look comes back empty.`;

/**
 * /subscription-signin — the standard procedure for keeping Claude Code and Codex
 * subscriptions signed in (operator directive 2026-09-24: one proven procedure baked into
 * every agent; skills over scripts, 80/20, Occam). Installed by installBuiltinSkills.
 */
export const SUBSCRIPTION_SIGNIN_SKILL_CONTENT = `---
name: subscription-signin
description: The standard, proven procedure for keeping Claude Code and Codex subscriptions signed in — Google-account profiles, normal-browser sign-in, repair, verification, and when to hand off. Use whenever a subscription shows "needs sign-in", a repair fails, or you set up a new account on a machine.
metadata:
  user_invocable: "true"
---

# /subscription-signin

How an Instar agent keeps its Claude Code and Codex subscriptions signed in, using only what has been proven on real accounts. Follow it with judgment; do not replace it with a script.

API calls below use \`Authorization: Bearer $AUTH\` against \`http://localhost:$INSTAR_PORT\` (port is in \`.instar/config.json\`).

## The chain (why it works)

1. **Each Google account has its own Chrome profile on each machine**, kept signed in to Google. Claude and Codex both sign in "with Google", so a healthy Google session in that profile is what makes every later re-sign-in a few clicks.
   When Google itself asks to sign in again, the agent types the account's password and its 6-digit authenticator code, both taken from the vault by name, in that same normal browser. No passkey and no automated browser are needed, so the Google side needs no human either.
2. **Sign-ins always run in a NORMAL browser** — the account's Chrome opened the ordinary way, never a remote-controlled/automated one (no DevTools/Playwright). Providers put human checks in front of automated browsers (Claude's Authorize never went through; Cloudflare "Just a moment" never cleared); the same profile opened normally passes. The built-in repair does this for you on macOS.
3. **The CLI login is started by Instar**, the browser only approves it: Claude gives a code to paste back; Codex (device code) finishes on its own.
4. **Success is measured, not assumed**: the account must read \`active\` with the expected email, and an authenticated call must work.

## Hard rules

- Never use an automated browser for a sign-in page. Never solve or work around a CAPTCHA or phone check — hand it to the operator.
- Never pick an account other than the expected one; never approve permissions beyond what the CLI requested.
- Never put a password, code, or token in chat, a file, or a command line. Secrets come from the vault by name.
- Never copy a Chrome profile or a login between machines — cookies are tied to that machine. Each machine gets its own profile and its own sign-in.
- Never drive or close a Chrome window you did not open (a person may be using it).

## 1. Setting up an account on a machine (once)

1. Check the profile registry: \`GET /playwright-profiles/resolve?service=google&identity=<email>\`. If there is none, create it: \`POST /playwright-profiles\` then \`POST /playwright-profiles/<id>/accounts\` with \`{"service":"google","identity":"<email>","owner":"operator"|"agent","vaultRefs":[...]}\`. Phone-first alternative: the Subscriptions dashboard's profile provisioning.
2. Make sure the vault holds the account's Google password and its authenticator (TOTP) secret, e.g. \`google_password_<name>\` / \`google_totp_<name>\`, and that the profile's account entry lists them in \`vaultRefs\`. If the account's authenticator is already on the person's phone (Google allows only one), don't replace it: store the account's unused backup codes instead (\`google_backup_codes_<name>\`, bound as \`backupCode\`). With both present the agent can sign the profile in to Google itself. If the account has no authenticator yet, adding one changes the person's 2-step settings: ask once for a yes, then add it from the signed-in profile and store the secret.
3. Enroll the subscription if it is not in the pool: \`POST /subscription-pool/enroll\` (never ask anyone to paste a token).

## 2. When a subscription needs sign-in

1. **Look first**: \`GET /subscription-pool\` (which account, which machine, \`needs-reauth\`), \`GET /subscription-relogin\` (any repair episode and its state), \`GET /subscription-pool/pending-logins\` (a live login waiting for approval).
2. **Let the built-in repair run.** In unattended mode it starts on its own for the listed identities; in approval mode it needs one dashboard tap (**Repair sign-in** on that account × machine cell). You cannot approve for the operator — send them the dashboard link.
3. **Read the outcome**: \`GET /subscription-relogin/<episode>/events\` (redacted). \`succeeded\` = done. Otherwise use the table below.
4. **Verify**: \`GET /subscription-pool\` shows the account \`active\`, \`identityDrifted: false\`, right email.

## 3. When a repair does not finish

| What the episode/page shows | What it means | Do this |
|---|---|---|
| \`captcha\` / \`phone-confirmation\` / operator-only | Provider wants a human | Tell the operator once, with the dashboard link; never retry through it |
| \`relogin-profile-in-use\` | That profile's Chrome is already open | Wait until it is closed; never close it yourself |
| \`pending-login-already-live\` on retry | An older login is still waiting | \`POST /subscription-pool/enroll/<id>/cancel\`, then retry |
| Google asks for the password or 2-step again | The profile's Google session expired | The repair types the password and authenticator code from the vault; if either is missing, do step 1.2 |
| Google asks for a phone tap, SMS, or "verify it's you" | Google's own risk check | Hand to the operator once; never try another method to get around it |
| Google asks for a second step on an account whose authenticator is on the person's phone | Normal for those accounts | The repair uses ONE saved backup code (vault entry bound as \`backupCode\`), removed from the list before use; when the list runs low, make new codes from the account's security page |
| Operator-only with reason \`plain-browser-automation-not-permitted\` | macOS hasn't allowed the agent to control Chrome on this machine | Ask the operator once to allow it (System Settings, Privacy & Security, Automation), then Try repair again |
| Anything else | Read the reason | \`GET /subscription-relogin/EPISODE/events\`: every attempt records a short reason token (e.g. \`chrome-launch-timeout\`) |
| Profile missing on this machine | Never set up here | Do section 1 on this machine |
| Authorize button stays greyed out | Normal on Claude until the page sees pointer activity | The repair handles it; if it persists after a minute, hand off |
| Repeated failures on one account | Something structural | Stop retrying after two attempts; report the episode id and last event |

## 4. Keeping it healthy (the 20% that prevents 80% of failures)

- One profile per Google account per machine, registered, signed in to Google, with password and authenticator secret in the vault.
- Keep each profile's Google session in use: open it in a normal browser about weekly, so an expiry is caught before Claude or Codex needs it.
- Don't hammer sign-in pages: each failed automated-looking attempt raises the provider's risk score. One clean attempt, then hand off.
- When you learn something new about a sign-in page, update this skill's table — the procedure is the memory.`;
