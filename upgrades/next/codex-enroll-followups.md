# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Three fixes found while enrolling Codex accounts onto remote machines after the
`--device-auth` fix landed. (1) The enrollment now creates the per-account config
home before launching the login: `codex` exits immediately when `CODEX_HOME` names
a missing directory, which every first-time enrollment does, so the login pane died
in under a second and the scraper blamed its 180s timeout (`login-did-not-start`).
It is created at the single spawn callback all enrollment paths share. (2) The
`EnrollmentWizard` now receives the COMPOSITE identity oracle instead of the
Anthropic-only one. The completion gate asks it for the minted slot's account email;
the Anthropic-only oracle cannot read a Codex home, so it returned `unavailable` and
the gate held every Codex enrollment with `missing-completed-email` no matter how
often it was retried. The composite oracle (which reads the slot's own `auth.json`
id_token) existed for exactly this and was never wired here. (3) The post-publish
smoke check now waits 15 minutes rather than 3 for npm propagation — a ~22MB
package can take over 4 minutes, so the step was failing releases that had in fact
published successfully.

## What to Tell Your User

Setting up a Codex account on another machine now works instead of reporting that
the sign-in never started, and a good release stops being marked as failed.

## Summary of New Capabilities

- First-time Codex enrollment succeeds on a machine that has never held that account.
- The account-identity check can now verify Codex credentials, so verified accounts register.
- The identity check keeps refusing anything it cannot verify — it is fed, not bypassed.
- Post-publish verification no longer fails healthy releases.

## Evidence

- Live on the Mac Mini: with the config home missing the login pane died instantly
  and `tmux has-session` reported it gone; with the same command and the directory
  created first, codex printed the verification URL and a `XXXX-YYYY` code and the
  pane stayed alive.
- Live: a Codex credential written correctly (`codex login status` → "Logged in
  using ChatGPT", id_token email matching the expected account) was still refused
  with `missing-completed-email` under the Anthropic-only oracle, and registered
  immediately (`outcome: validated`, status `active`) under the composite one.
- Three Codex accounts (amrch, dawn, adriana) went from permanently failing to
  enrolled and active on the Mac Mini using these fixes, each signed in hands-off.
- npm propagation: 1.3.1251 printed `+ instar@1.3.1251`, failed this check at 3m,
  and appeared on the registry roughly 4m after publish.
