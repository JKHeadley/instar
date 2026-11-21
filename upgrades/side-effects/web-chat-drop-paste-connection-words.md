# Side-Effects Review — Web chat: drop and paste files; Telegram's connection words

**Date:** 2026-11-19
**Author:** Echo (session echo-telegram-parity, Telegram topic 145738)
**Tier:** 1. Static dashboard assets only (`dashboard/console/chats.js`, `net-state.js`, `console.css`) plus tests. A revert fully undoes it. Size: 3 source files, about 70 added lines; 2 test files (1 new case, 4 wording assertions updated). Effort: no spec rounds (Tier 1), one commit attempt planned.
**Why:** Justin, 2026-11-19 12:11 PST (topic 134088): Telegram's features are the bottom-level requirement for Instar chats on every app, "including the UX quality such as responsiveness, low network connection handling/support, dragging and dropping media". The parity inventory (doc b7a1a10a, rows M6, M7, W6) lists the web chat as missing drop and paste, with connection words that differ from the other apps. Project: initiative `telegram-parity`, gap items g03 and g05.

## What changed

- **Drop and paste (M6/M7):** the Conversations composer has one `addFiles` path used by Attach, paste and drop, so all three share `checkFiles` (count and size limits) and the same chip tray. `paste` on the textarea takes files only (`pastedFiles`: `clipboardData.files`, else file items); a text paste is not prevented. A nameless `image.png` gets a time-stamped name. `dragenter`/`dragover`/`dragleave`/`drop` on the composer and the message list act only when the drag carries `Files` (`carriesFiles`), so link and text drags keep the browser's own behaviour. While a file drag is over the conversation, the composer shows a dashed accent outline and a "Drop to attach" pill. Nothing is sent until Send.
- **Connection words (W6):** `lineText` now leads with Telegram's words. With no network: "Waiting for network… Showing what I had at 1:52 pm." / "Waiting for network… Nothing saved on this device yet. I'll load it when the connection is back." When the agent does not answer: "Connecting… Showing what I had at 1:52 pm." / "Connecting… Still trying to reach the agent." The trailing "Trying again." was dropped, because "Connecting…" already says it. The states, the timing and what is saved are unchanged. The words are the cross-app set handed to the iPhone/Mac, Android and Windows builders, so every surface says the same thing. The original wording in `docs/specs/app-weak-network.md` is superseded for the lead words only.

## Decision-point inventory

None added or changed. No new gate, refusal or authority. Which files may be attached is still `checkFiles`. When to show which line is still `createNetState`.

## 1. Over-block
No issue identified. A drag without files is not intercepted. A text paste is not intercepted.

## 2. Under-block
Dropped or pasted files that break the limits are refused with the same status-line words as Attach. A drop while a send is in progress only adds to the tray for the next message.

## 3. Level-of-abstraction fit
The pure helpers (`carriesFiles`, `pastedFiles`) sit beside the page's other helpers in `chats.js` and are exported for tests. The wording stays in `lineText`, the single place it was before.

## 4. Signal vs authority compliance
No authority in this change. docs/signal-vs-authority.md applies unchanged.

## 5. Interactions
The Sessions page has its own drop and paste in `sessions.js` (untouched). The `dragleave` depth counter keeps the outline steady while the pointer crosses child elements. The net-state wording change affects every console page's top line, not just chats. Tests that asserted the old words are updated. No other code reads the text.

## 6. External surfaces
The web console only: the Conversations page composer and the shared connection line. The server, the apps and the uploads route are untouched.

## 7. Multi-machine posture
Machine-local static assets. The behaviour is the same whichever machine serves the console.

## 8. Rollback cost
Revert the commit. No data, config or migration.

## Operator-surface quality

- **Discoverable:** the "Drop to attach" pill appears as soon as files are dragged over the conversation, so no instruction is needed.
- **Plain words:** the three connection phrases are Telegram's. The age of the shown copy stays in plain time ("1:52 pm").
- **Phone:** paste works on mobile browsers that put images on the clipboard. Drop is a desktop and tablet action. At 390 px the pill and chips fit with no horizontal scroll.
- **Themes:** dark and light from existing tokens (`--accent`, `--accent-strong`, `color-mix`). Both checked.

## Verification

- `tests/unit/console-chats-page.test.ts`: new jsdom case. A text paste is not taken. A screenshot paste becomes "Pasted image HH.MM.SS.png" and enables Send. A link drag is not taken. A file `dragenter` outlines the composer, and the drop adds the file and clears the outline. Removing one chip keeps the other.
- `tests/unit/console-net-state.test.ts`: the four line texts in the new words.
- Run green: both files above (62 tests), plus guards dashboard-controls-labeled, operator-surface-gate, console-warning-paths, console-dom, no-silent-fallbacks, html-site-ratchet.
- Before/after screenshots: headless Chromium against a local mock of the console's reads (no live agent touched), origin/main vs this branch, 1100x1000 and 390x844, dark and light, plus "no network" and "agent unreachable" states. Saved in the agent home at `.instar/state/telegram-parity/shots/web-drop-paste-words-1119/` (`before-*.png`, `after-*.png`, `mockshots.mjs`).
