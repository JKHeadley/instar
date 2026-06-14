# Per-topic effort pin — plain-English overview

## What this is

Claude Code has an "effort" setting (low / medium / high / xhigh / max) that
trades speed for thinking depth. instar's topic profiles already let you pin a
model, a thinking mode, and a framework to a conversation topic so the choice
survives session restarts. This adds **effort** as a fourth pinnable field: a
topic can be pinned to, say, `max` effort, and every session instar spawns for
that topic passes `--effort max` to Claude Code — so the choice sticks across
respawns instead of resetting to the account default each time.

It was prompted by the operator asking to set "ultracode" for a topic. ultracode
is a Claude Code *session mode* (max effort + dynamic workflows) that the CLI
does **not** expose as a flag — `--effort` only accepts low/medium/high/xhigh/max
(verified by probe). So this pin reaches the real ceiling the CLI allows (`max`);
the workflow-orchestration half of ultracode has no command-line surface and is
filed as a separate harness gap.

## What already existed vs what's new

Existed: the whole topic-profile machinery (store, resolver, validation,
conversational "set X on this topic" grammar, the change-classifier that decides
whether a pin change needs a respawn, and the per-topic `--model` pass-through at
spawn). New: an `effort` field threaded through every one of those pieces, plus
the `--effort` argv injection in the Claude Code launch builders (interactive and
headless), plus a `/topic effort <level>` command and the conversational grammar
("set max effort here").

## Safeguards in plain terms

- **Closed enum, fail-open everywhere.** Only the five real CLI values are
  accepted. An invalid stored value resolves to "no effort flag" rather than
  passing garbage to the CLI — checked at the resolver, again at the launch
  builder, and rejected at the write API. `ultracode` is refused at every layer.
- **No behavior change unless set.** The field is unset by default; nothing about
  existing spawns changes until a topic is pinned.
- **Right respawn reason.** An effort-only change triggers a clean kill +
  `claude --resume` (effort is a launch-time flag, benign across resume) with its
  own honest reason — not mislabeled as a thinking change.
- **Non-Claude frameworks ignore it.** Codex/Gemini/Pi spawns are untouched.

## What the operator needs to decide

Nothing to configure — it's additive and off until used. Once merged, you (or I,
conversationally) can pin a topic's effort, e.g. "set max effort on this topic,"
and it survives restarts. The only standing caveat: full UI-"ultracode"
(workflow-default-on) still isn't pinnable from instar because the harness has no
CLI/spawn surface for it (tracked as a separate gap).
