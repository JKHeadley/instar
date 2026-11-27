# Side-Effects Review — calmer Home, PIN pre-check, dashboard preview

**Version / slug:** `console-held-replies-preview`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

Console Home drops the "Can I reach you" (held replies) card and excludes delivery status from the headline; the headline becomes the first "needs you" row as a link. `src/core/desktopTransport.ts` gains `dashboardUnlockRefused` (the exact rule the unlock route already used); `AgentServer` uses it for `POST /dashboard/unlock` and a new read-only `GET /dashboard/unlock-check` (exempt from bearer auth in `middleware.ts`), which the console calls before showing a PIN box. `src/server/dashboardPreview.ts` mounts `/dashboard/preview/` (static files from `<stateDir>/dashboard-preview`, no-store) and provides `publishDashboardPreview`, used by `scripts/publish-dashboard-preview.mjs`. Template + `migrateClaudeMd` add one awareness bullet. Tier declared 1 (signal said 2 from the migrator and a "publish" name match); size ~180 LOC source; reasoning in the trace.

## Decision-point inventory

- `POST /dashboard/unlock` secure/local rule — pass-through (same predicate, now named and shared).
- `GET /dashboard/unlock-check` — add — read-only signal; grants nothing.
- Console Home headline — modify — presentation only.

---

## 1. Over-block

No new block. The unlock rule is unchanged. The console now hides the PIN box only when the server itself says the unlock would be refused; if the check cannot be read it shows the box as before.

## 2. Under-block

The check exposes the tunnel URL to an unauthenticated caller on a non-secure, non-local address of an agent with remote desktop on. That caller already reached the server; the URL leads to the same PIN-gated page. The preview serves whatever files are in the state folder: anyone who can write that folder can already change the agent's code, so it adds no new writer. Held replies leaving Home means a genuinely stuck reply is no longer shown there; the existing held-reply attention item and Messages page still carry it.

## 3. Level-of-abstraction fit

The refusal rule lives once in `desktopTransport.ts` beside `isLoopbackPeer` and is consumed by the route and the check, so they cannot disagree. The preview is a static mount like the existing dashboard statics, before auth like them.

## 4. Signal vs authority compliance

The unlock-check is a signal (it reports the authority's own rule; the authority still decides at `POST /dashboard/unlock`). No new blocking authority.

## 5. Interactions

The preview mounts before `/dashboard` statics; `fallthrough:false` keeps preview misses from reaching packaged files. `dashboardSecurityHeaders` applies to the preview path (CSP 'self'). The CLAUDE.md bullet is inserted under the console bullet; the remote-desktop migration anchors on "Sharing the dashboard" and is unaffected (tests updated).

## 6. External surfaces

Two new HTTP paths (`/dashboard/unlock-check`, `/dashboard/preview/`), both read-only. Home shows five cards instead of six. Existing agents' CLAUDE.md gains one bullet on update.

## 6b. Operator-surface quality

1. Leads with its primary action: yes. Home's headline is now the first thing that needs the operator, as a tap target; a refused unlock shows "Open the secure address" as the only button.
2. Zero raw internals as primary content: yes. Held-reply counts and delivery internals leave Home; the preview banner says "Preview · work on <branch> · updated <time>. Not merged yet." (the branch name is the one technical word, shown only on the preview address).
3. Destructive actions de-emphasized: no destructive actions are added.
4. Plain language at phone width: yes. Checked in a phone-width DOM test; live phone screenshots follow once the preview route is live.

## 7. Multi-machine posture

Machine-local by design: each machine's preview is served from its own state folder, published from a checkout on that machine; the operator gets the one pinned link of the machine that fronts the tunnel. The unlock check answers for the machine it is asked on, which is the machine that would refuse the PIN.

## 8. Rollback cost

Revert the PR. The preview folder is inert without the route. The CLAUDE.md bullet stays on agents that updated (harmless text describing a missing route); a follow-up migration could remove it if needed.

---

## Second-pass review

Independent reviewer (subagent, diff-only read): no blocking issues. Notes acted on: the preview swap comment overstated atomicity (now says the address can briefly answer 404) and a failed second rename now restores the previous copy. Noted and accepted: the bearer exemption for `/dashboard/unlock-check` is redundant because the route is registered before the auth middleware (kept as belt-and-braces, harmless); `preview.json` shows branch and commit publicly, like the dashboard's other static files. Concur with the review.
