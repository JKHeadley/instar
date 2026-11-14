---
title: Quality history at a glance on the existing maturation board
slug: quality-history-glance
tier: 1
status: draft
eli16-overview: docs/specs/quality-history-glance.eli16.md
---

# Quality history at a glance

## Problem

On 2026-11-09 the operator was asked to "glance at the quality chart" and the link opened the maturation board, which has no chart on its first screen. The real history chart (`measurementChart` in `dashboard/console/measurement-trend.js`) only appears after tapping "Show measurements" on one coverage row. The constitution rule approved in PR #2842 asks every improving capability to "expose a clear visual history showing progress, regressions, and uncertainty at a glance". No page did that.

## Change

1. **Read.** `GET /maturation/board?part=quality` (same dev gate, same auth as the board). It takes one census of the existing measurement owners (`readMeasurementSubjects`, the same `collectMeasurementInputs` the coverage and detail reads use), then calls the existing `readMeasurementDetail` for each subject with that census, yielding the event loop between subjects. Each metric becomes one row: the current series (thinned to at most 24 real recorded points, first and last always kept, a line only where every original step was joined), the contract's direction/threshold/minSamples, the existing outcome proof for that metric (or null), the first and latest recorded point, and a status computed from the latest point: `off-goal`, `too-few-samples`, `at-goal`, `no-points`. Rows are ordered off-goal by distance from the target, then too-few, then at-goal, then empty; most-changed first inside a group. The response is bounded (400 subjects, 600 rows, 1 MB), cached 60 s and single-flight. No new state, store or registry; `advisory: true, authority: "none"`.
2. **Page.** `#/work/maturation?s=quality` (the console's `?s=` section convention; on the standalone page `/dashboard/maturation/?s=quality`). One answer sentence ("N of M measured items are off their goal"), one warning when items have no recorded starting point (with an ask link), a one-line key, then a grid of small charts, twelve first and the rest on request. Each chart is the existing `measurementChart` with a new optional goal line (amber dotted, labelled) and no per-chart caption; the corroborated baseline line and hollow (unverified) dots keep their existing meaning. Under each chart: one plain status line and, when the comparison is not verified, "Comparison not verified (no starting point)". Off-goal cards carry "Ask what to do". The board gets a "Quality history charts" link under its answer.
3. **Awareness.** A `Quality history at a glance` CLAUDE.md section (template + content-sniffed migration) so agents send the direct link instead of the plain board link.

## Honesty rules

- Points are real recorded values; thinning never averages or interpolates.
- `change` is the recorded difference across the window and is never labelled improvement. Only `proof.comparisonAvailable` with a verified baseline removes the "not verified" label.
- Future-dated points are excluded from first/latest and the chart already refuses them.
- Unreadable subjects are counted in `notReadable`, never shown as zero or empty charts.

## Multi-machine posture

Machine-local by design for this read: each machine's series comes from its own measurement ledger, and the page says "on this machine". The board's existing per-subject pool route (`part=measurement&machine=`) remains the way to read another machine's detail.

## Rollback

Revert the commit. No data, config or migration state is written; the CLAUDE.md section is inert text.
