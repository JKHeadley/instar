# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

`scripts/lint-no-unfunneled-tmux-literal-send.js` now matches the bracket-matched ARGV ARRAY rather
than a single line.

That lint guards the `send-keys -l` argv ceiling (~16.2 KB) — the class behind the 2026-08-04 incident
where a ~40 KB prompt blew the ceiling, the circuit breaker misread the opaque send error as a provider
rate-limit and tripped 14 consecutive times, and ten LLM-backed components sat at 76-100% error rate.

It required `send-keys` and `'-l'` on the SAME line, so four PLAIN literal forms evaded it — measured
against the shipped check with the one-line form as a positive control firing in the same run: a
multi-line array (what any formatter produces), the flag lifted into a const, the verb lifted into a
const, and — worst in kind — merely NAMING the funnel in a comment on that line, so
`// TODO: use buildLiteralSendArgs` beside a raw send silenced the guard the TODO was admitting was
needed.

The first is the one that matters: **the guard could be defeated by running prettier.**

Added: `stripComments` (quote-aware, line-number preserving), `collectStringConsts` (per-file;
conflicting bindings dropped as unresolvable), `arrayRegions` (bracket-matched, string-aware, bounded),
`regionViolates` and `scanSource`. The rule, the exemption and the message are unchanged. Also added a
direct-invocation guard — importing the module previously ran the whole `src/` scan and could
`process.exit(1)`, which is why its internals had never been unit-tested.

## What to Tell Your User

Nothing changes for you. A build-time check that stops a known way of breaking terminal sends could be
walked past just by letting a code formatter split a list across lines — no intent required. It now
reads the whole list instead of one line. Nothing you use behaves differently; a failure mode that once
took down ten components for hours got harder to reintroduce by accident.

## Summary of New Capabilities

None. No new command, endpoint, setting, or runtime behaviour. A CI guard that a code formatter could
defeat no longer can be.

## Evidence

- `tests/unit/tmux-send-lint-array-scope.test.ts` — 18/18 green.
- **Negative control: 6 of 18 fail** against the shipped line-oriented behaviour; the other 12 pass both
  ways and are the controls. Source restored byte-exact afterwards (sha match, zero markers left).
- Six anti-over-block controls, because this lint blocks commits: send-keys without the flag; a genuinely
  funnelled call; two SEPARATE arrays never joined; a const bound to a different flag; an example living
  entirely inside a comment; and an identifier with conflicting bindings left unresolvable.
- Real tree: `exit 0` before AND after, 1,631 files scanned.
- Full `npm run lint` chain green; chain membership verified explicitly rather than inferred.
- **Scope CORRECTED, not restated:** the old header claimed only that a dynamically-built argv could
  evade it. None of the four measured evasions is dynamic. The header now names what was actually
  missing, and the genuine remainder (a runtime-assembled array — push/concat/spread/helper).
