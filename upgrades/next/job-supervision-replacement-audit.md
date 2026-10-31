# Scheduled-result outage backup audit

## What Changed

The opt-in replacement benchmark now rejects malformed model replies as failed audited calls. It records model identity and usage reported before failure, and attaches usage reported after a timeout to that failed call while its store remains open. Haiku calls request schema-constrained JSON and require the CLI's served-model report. Codex calls can pin one model without an automatic model-retirement retry. Named corpus cases can be selected while retaining the daily token cap.

## Evidence

The October 30 Luna trial produced 17 expected parsed labels from 17 distinct synthetic cases; four “cannot tell” cases need a strict-format rerun. The earlier Haiku trial is unqualified. The production rollout gates remain closed. See `docs/specs/job-result-supervision-v2-benchmark-evidence.md`.

## What to Tell Your User

The optional backup-model test now checks the exact response format and keeps the model and token usage reported for a failed or timed-out call. The change improves the audit trail; it does not turn on live backup decisions. Haiku and Luna still need more evidence before either can be used as a live backup.

## Summary of New Capabilities

The bounded benchmark can select named synthetic cases and record whether each model reply had the required format. Audited Claude calls can require schema-constrained JSON and a served-model report. Audited Codex calls can hold one model pin without an automatic retirement retry. Failed calls retain available model and usage observations without allowing a late answer to settle a job result.
