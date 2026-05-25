# Upgrade Guide — Codex safety hooks run unprompted in autonomous sessions

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Codex (codex-cli) agents now run instar's safety hooks without the interactive
"trust these hooks?" prompt that would otherwise freeze an unattended session.**

Codex requires a one-time review/trust of any command hook before it runs. In an
interactive session that prompt blocks until answered — and it even offers a
"continue without trusting (hooks won't run)" option, so an agent could decline its
own guards. instar now launches codex with `--dangerously-bypass-hook-trust` (added
in codex 0.133), which runs the already-vetted instar hooks with no prompt.

This is safe-by-construction: instar both writes the hooks (`installCodexHooks`) and
owns the launch command, so there's no untrusted third-party hook to guard against,
and the agent can't strip a flag from a launch it doesn't construct. It's a per-agent
launch setting — it touches nothing system-wide and does not affect the operator's own
personal codex sessions (those still prompt normally).

The flag is **capability-gated**: instar probes `codex --help` once per binary and only
adds the flag when present. On codex <0.133 (which lacks the flag and would reject it),
it's omitted and behaviour degrades to the safe-by-blocking trust-prompt path.

## What to Tell Your User

If I'm running on Codex without you watching, my safety guard now kicks in on its own
instead of stopping to ask you "do you trust this guard?" first — a question that would
have frozen me mid-task, and that technically let me wave my own guard off. Now the
guard just runs. This only applies to how I launch Codex; when you use Codex yourself it
behaves exactly as before.

## Summary of New Capabilities

No new user-facing capabilities — this completes the Codex enforcement-hook layer so its
guards work in unattended/autonomous sessions, not just interactive ones where a human can
answer the trust prompt. Internal: `codexCapabilities.codexSupportsHookTrustBypass()`
(memoized feature probe) + both codex launch builders append the flag when supported.

## Evidence

**Live reproduction (real codex 0.133, no trust ever granted).** Launched interactive
codex with `--dangerously-bypass-hook-trust` and a hook whose trust hash had been
invalidated:

- Codex launched **straight to the prompt — no "trust these hooks?" review** (banner:
  `⚠ Enabled hooks may run without review for this invocation`).
- Told it to run `echo 'rm -rf /'` — the guard fired and blocked it; codex itself reported
  it was blocked for the catastrophic `rm -rf /` pattern, and the guard's debug trace
  logged the fire. Before this, the same setup either blocked on the trust prompt or ran
  unguarded.

Also verified instar's builder emits the flag for the real codex binary, and the
capability probe correctly omits it for a binary whose `--help` lacks it. Unit coverage:
`codexCapabilities` (5) + `frameworkSessionLaunch` (+4). `tsc` clean.
