# Accounts integration handoff

This directory captures WIP evidence and merge resolutions. The saved Accounts branch remains at `999d624854a784efc594b3755c2edecdbfdfde29`. The files here do not install or publish anything. Keep the existing approval holds and send any eventual combined candidate through normal integration and release verification.

## Responsive detail grids

The grid branch at `3fedcfd22c3740f900b32c6757bb39bb243f71c1` and the Accounts repair conflict in the Accounts list wrapper. Keep one list sorted by weekly reset, and add `acct-card-grid` to the wrapper around `page.accounts.map`. The grid branch supplies the necessary CSS and router class. `grid-accounts-wrapper.patch` is the minimal hand resolution against the Accounts parent. The conflict was confirmed by a file-level three-way merge. No combined visual check ran.

## Weekly allowance forecast

The forecast branch at `44cbd527abd6cf8805bc3f0b35be5ec7486ac6b4` conflicts in the end of the Accounts page render. Keep the current visit callback in `autoRepairSection(autoRepair, currentVisit)` and include the forecast card before the legacy link. `forecast-accounts-wrapper.patch` shows the combined import and call. It assumes the forecast branch contributes its card and projection modules.

The combined lifecycle fixture originally failed two assertions. A successful cancellation rerender made ten reads and the navigation fixture made five. They expected eight and four respectively, since each render now makes a separate forecast read. An asynchronous forecast render also outlived the test DOM during teardown. `forecast-lifecycle-test.patch` checks the two types of reads separately and lets the forecast settle before closing the fixture DOM. The corrected composition passed all 14 lifecycle cases with no unhandled errors. The source hashes identify the private composition that was tested. Apply the fixture change only with the forecast behavior.

All three patches are based on the Accounts parent. Use them as conflict-resolution references. Check applicability before applying them to any different base.

## Local browser PIN proof

The shared UI helper merged cleanly with Identity tip `bf7ba11fc8094568e5f63c62a32984e2224263e8` using merge base `1d6be3d585b283f0dbaf87c10a2be88958386a11`. Keep the Identity unlock transport and the Accounts visit and dialog guards. This is independent of the already documented Ideas overlap.

Keep both exact source commits in the local Git object store. Run with locally installed Playwright and Chromium. The preparation command needs a Git version that supports `merge-file --object-id`. It creates a private directory for the two sources. The runner verifies every imported source file against its recorded hash, opens a loopback server and temporary Chromium contexts, creates an invented credential in IndexedDB, blocks off-origin page requests, and stubs all API responses. No live account or signed-in browser profile is used.

```sh
accounts_ref=999d624854a784efc594b3755c2edecdbfdfde29
identity_ref=bf7ba11fc8094568e5f63c62a32984e2224263e8
base_ref=1d6be3d585b283f0dbaf87c10a2be88958386a11
source_dir=$(mktemp -d)
git archive "$accounts_ref" dashboard/console | tar -xf - -C "$source_dir"
git show "$identity_ref:dashboard/local-access.js" > "$source_dir/dashboard/local-access.js"
git merge-file --object-id -p \
  "$(git rev-parse "$accounts_ref:dashboard/console/ui.js")" \
  "$(git rev-parse "$base_ref:dashboard/console/ui.js")" \
  "$(git rev-parse "$identity_ref:dashboard/console/ui.js")" > "$source_dir/dashboard/console/ui.js"
node tests/fixtures/accounts-integration-audit/run-local-pin-browser.mjs /path/to/playwright/index.mjs "$source_dir"
```

The optional third argument writes a JSON receipt. The two late-response cases preserve the replacement dialog, leave no local operator session and issue no Accounts mutation. The current visit sends one repair configuration request. Every case independently verifies the signed browser proof. Server acceptance, state persistence, full verification and release remain outside this fixture. `local-pin-browser-receipt.json` records the earlier exact source replay.

The grid composition also passed eight disposable Chromium checks at 390, 1280 and 1600 pixels in both themes, including enlarged text at laptop width. It kept a single vertical list with no horizontal page overflow and issued no application writes. The [geometry receipt](grid-browser-receipt.json) binds the measurements to the exact merged renderer and stylesheet.
