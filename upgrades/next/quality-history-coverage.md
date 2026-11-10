# Upgrade Guide — quality-history-coverage

## What Changed

The quality history page (`#/work/maturation?s=quality`) now accounts for every item. The line under the headline names every group, including items with no recorded values yet. A first-screen line says what the page does not show: that it covers this machine only, how many tracked items have no measurement, how many could not be read, and how many were past the read limit. It carries a link to ask what to cover next, and the key says when long histories were thinned. `GET /maturation/board?part=quality` now spends its 400-subject read limit on subjects that have a measurement contract, and counts the rest as `noMeasurement` without reading them. Measured items can no longer be dropped behind unmeasured ones.

## What to Tell Your User

The quality charts page now says plainly what it leaves out (items with no measurement yet, items on other machines) so the picture does not look more complete than it is. It also always reaches the measured items first.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Quality history coverage line | Automatic, on `#/work/maturation?s=quality` |
| `noMeasurement` count | `GET /maturation/board?part=quality` |

## Evidence

Unit, integration and e2e tests listed in `upgrades/side-effects/quality-history-coverage.md`. The page was loaded in Chrome at 390x844 and 1280x728 with the live response from the Studio, captured at 21:23Z. It shows "Worst first. 14 have too few samples to judge, 20 are at goal, 11 have no recorded values yet." and "This machine only. Not shown: 381 tracked items with no measurement yet, 1634 past the read limit."
