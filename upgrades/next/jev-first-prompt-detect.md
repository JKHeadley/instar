## What Changed
- **PromptGate's blocking-prompt check now also asks Jev, in shadow only.** A second point, `prompt-detect`, joins the shared Jev-first gateway in front of PromptGate's model call. When the existing quiet-pane and status-bar pre-filters let a terminal tail through, PromptGate starts its normal model call first and, beside it, asks Jev the blocking-prompt question frozen from the 12 Nov 2026 replay (band: "no" at 0.5 or below, "yes" at 0.8 or above; Jev may only ever settle "no"; model `jev-1.13.0`). PromptGate acts on its normal model's answer in every case. Jev's answer, the incumbent's answer and the secret-scrubbed terminal tail are written to the local judgment provenance log so real prompts can be graded later.
- **Nothing Jev does can change PromptGate.** The Jev comparison is never awaited by detection; a Jev error, timeout, wrong model, missing key, oversize tail or provenance failure is recorded and ignored. The stage is clamped to shadow in code even if config asks for live.
- **Switch.** `intelligence.jevFirstPrompt.enabled` (dev-gated: shadow by default on a development agent, off on the fleet; read live). A ladder entry tracks the evidence needed before any promotion.
- **Summary.** `GET /jev-first/summary` now shows a `prompt-detect` row next to `commitment-detect`.

## What to Tell Your User
Nothing changes in how I spot a session waiting on a question. On development agents I now also quietly compare a small, cheaper model's answer against the normal one, so we can later tell whether the cheaper model is good enough to take over some of that work.

## Summary of New Capabilities
- Jev-first point `prompt-detect` in shadow beside PromptGate's model call, with scrubbed provenance rows for later grading.
- `intelligence.jevFirstPrompt` switch (dev-gated, live-read, clamped to shadow).
- `prompt-detect` row on the Jev-first summary.

## Evidence
- `tests/unit/PromptGate-jevFirst.test.ts`: the frozen question, band and model; dev-gate and live-to-shadow clamp; Jev receives the framed 20-line tail and the provenance row holds the scrubbed tail; a confident Jev "no" does not suppress a blocking prompt the incumbent found; Jev throw, late rejection, wrong model and missing key leave PromptGate's relay unchanged; a throwing gateway or point reader changes nothing; pre-filters still skip both calls; a synchronous incumbent throw stays silent.
- `tests/integration/jev-first-summary-routes.test.ts`: a real InputDetector feeding the metrics ledger produces a `prompt-detect` summary row over HTTP.
- `tests/e2e/decision-quality-alive.test.ts`: the production server source wires the factory into PromptGate, the dev-gate is registered, and on the real AgentServer boot the summary shows the `prompt-detect` row while the incumbent's prompt is still relayed.
