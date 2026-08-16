# Build Brief — Bring the INSTAR Feedback Pipeline FULLY ACTIVE (Echo-operated instance)

You are a dedicated, decoupled build session under a FULL-AUTONOMY mandate (Justin, 2026-06-14,
topic 12476: "take complete responsibility for the INSTAR feedback pipeline and bring it fully
active so you can start managing the feedback system" — preapproval for ALL decisions; log
decisions, report milestones, DO NOT STOP). Work autonomously to completion. Report milestones to
Telegram topic 12476.

## The goal (concrete done-state)
Echo's OPERATED feedback receiver is LIVE and self-managed:
`https://feedback.dawn-tunnel.dev/api/feedback` accepts an HMAC-signed feedback POST → persists to
the Vercel Blob inbox → Echo's server InboxDrainer pulls it → JsonlFeedbackStore. A real end-to-end
test feedback flows through and is readable in Echo's local feedback store.

## Decisions already made (Justin preapproved; logged in .instar/autonomous/12476.local.md)
- **D1: endpoint domain = feedback.dawn-tunnel.dev** (Cloudflare zone, self-serviceable). NOT
  feedback.instar.sh (Namecheap, no reachable cred). Re-point to instar.sh later if that cred surfaces.

## Design ground-truth (read these first)
- Converged spec: `docs/specs/feedback-factory-migration.md` (v2, Dawn-reviewed). Option-B open/operated split.
- This branch (#1065, echo/feedback-receiver-persistence) IS Echo's receiving end: `feedback-front/`
  (Vercel functions: src/feedback.ts, src/health.ts; build via `npm run bundle` = esbuild → api/) +
  `src/feedback-factory/receiver/` (BlobInboxStore, InboxDrainer, defense.ts, handlers.ts).
- HMAC: shared secret **INSTAR_WEBHOOK_SECRET = `instar-rising-tide-v1`** (the receiver TRIMS it at
  load, so trailing newline is safe). Sig = HMAC-SHA256 over `` `${timestamp}.${body}` ``,
  headers x-instar-signature + x-instar-timestamp, 5-min replay window.
- Front env needed (set on the feedback-front Vercel project): `BLOB_READ_WRITE_TOKEN` (+/or
  `FEEDBACK_INBOX_BLOB_TOKEN`/`FEEDBACK_INBOX_BLOB_API_BASE`), `INSTAR_WEBHOOK_SECRET`.

## Your access (you can self-serve everything — never treat a cred as a blocker)
- **Bitwarden**: `SESS=$(bash ~/.instar/agents/echo/.instar/scripts/unlock-bw.sh)` → 88-char session.
  Then `BW_SESSION=$SESS bw get item "Cloudflare API Token - dawn-tunnel.dev"` → custom field "token"
  = the CF Zone-DNS-Edit token for dawn-tunnel.dev. NEVER echo secret values into the transcript.
- **Vercel**: CLI authed as jkheadley (team sagemind). Project `feedback-front` (prod currently a
  healthy promoted build `feedback-front-4mp3wbw0a`). `ssoProtection=all_except_custom_domains` so the
  CUSTOM domain is public (the *.vercel.app 401 is expected + irrelevant).
- **GitHub**: `GH_TOKEN=$(node ~/.instar/agents/echo/.instar/scripts/secret-get.mjs github_token)`. Canonical = JKHeadley/instar.
- Echo server API: `AUTH=$(node ~/.instar/agents/echo/.instar/scripts/secret-get.mjs authToken)`, base `http://localhost:4042`.

## Plan (drive to completion; log non-trivial decisions)
1. **Vercel Blob store**: check if feedback-front has a Blob store + the env vars (link the project
   first: `vercel link --yes --project feedback-front --scope sagemind` from feedback-front/). If no
   Blob store, create one (`vercel blob` / dashboard API) and wire BLOB_READ_WRITE_TOKEN. Set
   `INSTAR_WEBHOOK_SECRET` = `instar-rising-tide-v1` via `printf` (no trailing newline) for production.
2. **Build + deploy the front** from THIS tree: `cd feedback-front && npm run bundle` (produces api/),
   then `vercel deploy --prod --yes` (or promote). Confirm prod ● Ready.
3. **Attach the domain + DNS**: `vercel domains add feedback.dawn-tunnel.dev feedback-front`; then add
   the DNS record in Cloudflare via the CF token — `CNAME feedback → cname.vercel-dns.com` (proxied
   OFF / DNS-only) in the dawn-tunnel.dev zone (zone id via the CF API). Wait for `dig feedback.dawn-tunnel.dev` to resolve.
4. **Verify the endpoint**: HMAC round-trip — `feedback-front/scripts/local-hmac-roundtrip.mjs` or
   craft a signed POST to https://feedback.dawn-tunnel.dev/api/feedback with secret instar-rising-tide-v1.
   Expect 2xx + the report landing in the Blob inbox.
5. **Receiver drain (Echo side)**: ensure Echo's server runs the InboxDrainer against that Blob inbox →
   JsonlFeedbackStore. This needs #1065's receiver code in Echo's running server. Merge #1065 to
   JKHeadley/main through the instar-dev gate (it's the "normal merge" half), so Echo picks it up on
   update; OR wire the drainer config to point at the new Blob inbox. Verify a posted test feedback
   appears in Echo's feedback store (GET the feedback API / read the JSONL).
6. **Sender repoint (#1066)**: update the canonical feedback URL default to
   `https://feedback.dawn-tunnel.dev/api/feedback` (FeedbackManager + scaffold templates +
   PostUpdateMigrator migration target), drop the [HOLD] label, run the instar-dev gate, rebase onto
   current JKHeadley/main, FOREGROUND push, watch CI, MERGE when green. (This repoints the fleet; the
   merge is AUTHORIZED now — Justin gave the go.)
7. **End-to-end confirmation + report**: a fresh feedback from the instar sender lands at
   feedback.dawn-tunnel.dev → Blob → Echo drains → store. Report DONE with receipts.

## Discipline
- instar-dev gate for any instar SOURCE commit (#1065/#1066): fresh trace + side-effects artifact +
  ELI16 in PR body + decision-audit + parent-principle. Husky shim: `ls .husky/_` non-empty before
  first commit (run `npm ci && npm run prepare` if missing — raw worktree).
- Push FOREGROUND. Canonical main = JKHeadley/main (origin is a fork mirror). Fast main → rebase + re-verify the dev-gate lint line-map before re-push.
- Report to topic 12476 at real milestones only (front live → endpoint verified → receiver draining →
  #1066 merged → e2e done): `cd ~/.instar/agents/echo && cat <<'X' | .claude/scripts/telegram-reply.sh 12476 ... X`. Receipts, not intentions.
- Log any non-trivial decision in `~/.instar/agents/echo/.instar/plans/feedback-activation-decisions.md` for end-review.
- Cross-party note: Dawn's proxy-forward (Phase 5) + dual-forward (Phase 3) are coordinated separately by the main session — you focus on the Echo-operated instance going live + the sender repoint.
