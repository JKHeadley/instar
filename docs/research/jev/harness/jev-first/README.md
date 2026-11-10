# Jev-first replay harness

The earlier exploratory results are summarized in `../../jev-first-inventory.md`.
Raw samples, per-row probabilities, and source result files remain on Echo's
machine. They contain or join to private conversation data and are not part of
this change.

The prospective tone-gate holdout is defined in
`../../tone-future-holdout-2026-11-03.md`. From this directory on Echo:

1. Run `node build.mjs` to rebuild `sample-tone.json` from local provenance.
2. Run `FUTURE_SINCE=2026-11-04T03:10:00Z node run.mjs tone`.
3. Run `FUTURE_SINCE=2026-11-04T03:10:00Z node tone2.mjs`.
4. Run `python3 future_tone.py` to score the frozen thresholds.

The two Jev scripts use pinned `jev-1.13.0`, write separate future output files,
and skip ids already scored. `future_tone.py` prints counts only and writes ids
for independent review. The generated files are gitignored.
