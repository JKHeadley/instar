# Separate account usage from sign-in repair

The Accounts renderer projects usage from existing quota windows and repair status from exact account and machine records. Changes to sorting and grouping affect usage only. Routine gaps, stopped repairs and disabled sign-ins remain status rows. An explicit owner-only condition can still offer the established guarded sign-in path. The account details sheet keeps deliberate management controls and machine names.

The server adds a list of machines that returned an account inventory, including an empty one. A failed peer does not enter the list. This is a read-only signal that helps the browser distinguish a missing slot from unknown coverage. It schedules no work and grants no authority. No device policy, credentials, config or storage change.

Rollback is a revert of the follow-up. Older client and server versions remain compatible with the additive machine list.

## 6b. Operator-surface quality

- Known usage and reset times lead the ordinary page. Group and sort controls act on usage only.
- Sign-in repair is one named section with one summary per affected machine. Expanding the summary shows its affected accounts. Machines with confirmed sign-ins for every account share one summary. Unchecked sign-ins stay in the machine’s status. Routine repair rows have no Ask or sign-in action. A real owner-only sign-in still leads when present.
- Names and plain status copy are displayed. There are no raw machine or account identifiers on the page.
- Chromium tests exercise 390 and 1280 pixels in both themes, including overflow and the grouping controls' minimum hit area.

Each account shows the newest parsed reading for each available quota window across its machine rows. Choosing a machine in the layout does not change the bars. A short sign-in line remains visible alongside the usage. Accounts with no readings keep a neutral row. The browser never treats an absent reading as zero usage.

## Second-pass review

**Reviewer:** independent second-pass reviewer (Claude Fable 5.2 helper for the Echo Chief of Staff session), not the author

Concur for head `fb25191e5ebb20f8ccb38c8017ecc83d8ec8b022`. I read the full diff against main and the surrounding code. No changed path matches the harness classifier's globs. I ran three focused test files on this head, one at a time, and all passed: `tests/unit/console-needs-first-screen.test.ts` (162), `tests/unit/console-accounts-lifecycle.test.ts` (16) and `tests/unit/console-development.test.ts` (36). I ran no suite; the full Local Verify run on this head is the test evidence.

My first read, at head `36f0c1a5d6b3e643eca400c3dd754abba4e3018c`, was a dissent. A repair waiting in `suggested` on an approval-mode machine had been presented as agent work: it had no button in the repair section, it dropped off the Home Needs-you list, and the test that pinned it had its input changed to another state. Commit `fb25191e5` fixes that, and I checked the fix as follows.

- **Owner steps are back.** In `dashboard/console/accounts-model.js` a cell whose episode has `mode: 'approval'` and state `suggested` or `failed` is an owner action again, with `approve` or `retry`, the labels "Repair" and "Try again", and its episode id. It enters `page.needs`, which is what `dashboard/console/needs-model.js` reads for the Home Needs-you list. The served episodes are full store rows, where `mode` is a required column, so the condition is not vacuous on real data.
- **The pinned test tests a suggested episode again.** The single case in `tests/unit/console-needs-first-screen.test.ts` is now four: `suggested` and `failed` in approval mode must surface one row linking to the repair section, and the same states in unattended mode must surface none. This is stronger than the original.
- **The reminder's link leads to the button.** The repair section keeps the id the reminder links to, a machine with an owner action opens expanded, and the new cases in `tests/unit/console-accounts-lifecycle.test.ts` click "Repair" and "Try again" from that address and assert the exact repair request, including its action and episode id.
- **Nothing else moved.** The fix touches four files. The PIN prompt, the Promote flow and the usage projection are unchanged from my first read. The Promote test still asserts the single PIN-bound request from both placements.
- **No check is weakened.** I found no skip, raised timeout, or assertion that can pass vacuously. The rewritten tests assert the behaviour this artifact declares.

Non-blocking notes: an expired sign-in with no repair episode has no manual "Sign in" button anywhere, which this artifact declares as intended. A slot that holds another account's login stays agent work even when its last repair failed in approval mode. A `failed` repair in unattended mode stays agent work and relies on the automatic retry.
