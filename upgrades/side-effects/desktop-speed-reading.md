# Remote Desktop speed reading

Tier 1. Viewer only: `dashboard/desktop.js`, `dashboard/desktop.html`, `dashboard/desktop.css`, one new unit test file, and the spec with its ELI16 overview. No server route, protocol message, host helper, persisted state or config changes.

## Decision and operator impact

The quality spec (`docs/specs/native-remote-desktop-quality.md`) still lists the measured delay from the owner's input to the remote screen changing as open. The viewer now times each click, key press and scroll until the next decoded picture, and counts how often pictures arrive while the screen is changing. A new Speed button in the controls menu shows a small readout, for example "Delay 80 ms typical, 140 ms at worst · 16 pictures a second while it changes". It is off until tapped, and the numbers stay in that browser's memory only.

Plain pointer moves, button and key releases, and modifier presses are not timed, because the Mac host does not draw its own pointer (`showsCursor = false`), so a move alone rarely changes the picture. An action that changes nothing is counted as unanswered unless an unrelated picture arrives within 1.5 seconds. That limit is stated in the spec.

## Verification and rollback

`tests/unit/desktop-feel-meter.test.ts` has 18 cases: percentiles, bursts, an unanswered action, untimed moves, releases and modifiers, a late picture, smoothness with and without enough gaps, the still-measuring text, singular wording, reconnect, refused inputs, the JPEG decode path and its epoch skip, the Speed toggle, and a page without the readout. All 14 unit files that evaluate or read the desktop viewer pass on the M5 (221 tests) on main 2fb068610 merged. Revert the commit to remove the button and the meter. Nothing is stored, so there is nothing to clean up.

## Second-pass review

**Reviewer:** an independent sub-agent with no part in writing the change (read-only), two rounds on 27 Nov 2026.

Round 1 objected with five findings (an idle clock read as motion, moves inflating the delay, a waiting clock surviving a reconnect, the readout overlapping the bar, and untested paths). All five were fixed. Round 2 approved, and its two non-blocking points were applied (modifier presses untimed, and the spec's limits wording). After review, the first full test run caught that 0 was used to mean "nothing waiting", and the fix changed seven lines in `dashboard/desktop.js` to use null instead. The tests did not change.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a delay figure must come from a picture the browser actually decoded, never from an arrival or an assumption. The JPEG path counts only after `image.decode()` resolves for the current stream, the H.264 path counts after `drawImage`, and the tests pin both.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-speed-reading.eli16.md.

The readout says "Measuring speed: click, type or scroll on the remote screen a few times." until five actions are answered, then gives the reading in one plain line. The locked-screen password box covers the readout, which is acceptable because nothing is being measured while the screen is locked.
