# Upgrade Guide — `instar spec conformance` CLI

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**You can now run the standards-conformance gate from the command line.**

The conformance gate (shipped in v1.2.69) checks a draft spec against the living
constitution and reports possible standard-violations — but until now you had to
call its HTTP route directly. This adds the tracked `scg-cli` follow-up: a
command-line entry point.

`instar spec conformance <path>` reads a spec file, sends it to the local server's
conformance route, and prints a rule-by-rule report — "this part might break
No-Manual-Work, here's why." It's a thin client over the existing route, so the
subscription-backed model stays server-side (the CLI never touches a raw API). It
**advises only** — it prints possible violations, never a pass/fail that blocks
anything. `--json` emits the raw report; `--port`/`--dir` override the defaults.

If the server isn't running it says so clearly and exits non-zero, rather than
hanging or crashing.

**Evidence**: 5 unit tests (posts the spec markdown to the route, renders flagged
findings, clean-pass, degraded-as-advisory, `--json`, missing-file exit). `tsc` +
lint clean.

Spec: `docs/specs/standards-conformance-gate.md` (the `scg-cli` tracked deferral,
now shipped). Side-effects: `upgrades/side-effects/scg-cli.md`.

## What to Tell Your User

- **Check a spec from the terminal**: "Run `instar spec conformance <path>` and I'll
  check that spec against our standards and point out anything that might break a
  rule — it's advice, not a gate."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Conformance check from the CLI | `instar spec conformance <path> [--json] [--port N] [--dir P]` |

## Evidence

Not a bug fix — a CLI wrapper over the existing conformance route. Verified by 5
unit tests that stub the server and assert the command posts the spec markdown and
renders the report (findings, clean-pass, degraded-advisory, JSON, missing-file
exit). `tsc` + lint clean.
