# AnyDesk-level phone remote desktop: what to build

Research date: 2026-10-31. Scope: how AnyDesk's iOS and Android apps control a remote desktop, cross-checked against Microsoft Remote Desktop, Chrome Remote Desktop, Screens, Splashtop, Jump Desktop, TeamViewer and RustDesk. Purpose: a checklist for our native iOS client and our mobile browser viewer.

How to read this: **Confirmed** means an official AnyDesk page or changelog says it. **Third-party** means a guide or review says it. **Not confirmed** means I could not find a reliable source; the recommendation there comes from the other products, not from AnyDesk.

AnyDesk's own documentation is thin on gestures. The fullest official gesture list is on the Android page. The iOS page lists the menu and settings but no gestures. Some third-party guides disagree with each other and with the official pages.

---

## Key findings in one screen

1. AnyDesk has two input models on a phone. **Touch** (tap where you want to click) and **touchpad** (the phone is a laptop trackpad and moves a cursor). Android adds a third, **mouse mode**, as its default for phone-to-desktop. On iOS, touchpad has **not** been the default since version 4.1.1 (Jan 2020). Confirmed.
2. In touchpad mode: one finger moves the pointer, tap = left click, hold = right click, three-finger tap = middle click, three-finger swipe = scroll, two-finger pinch = zoom. Confirmed (Android page). Drag = double-tap then hold on the second tap. Third-party.
3. AnyDesk draws its **own local cursor** in touchpad mode (iOS 4.1.0, Dec 2019). It also offers "show remote cursor" and, since iOS 8.3.0 (Oct 2026), **"follow remote cursor"**. Confirmed.
4. The session menu on iOS opens by **swiping in from either screen edge**. On Android it is a **floating AnyDesk logo**: long-press opens a pie menu with five tiles; double-tap and drag moves the logo. Confirmed.
5. The keyboard has a **standard** mode and a **special** mode (F-keys, Ctrl and similar). Ctrl+Alt+Del is in the Actions menu. Hardware keyboards, Magic Keyboard, and hardware keyboard layouts are supported on iOS. Confirmed. How modifiers latch is **not confirmed**.
6. Performance: AnyDesk's DeskRT is a proprietary codec tuned for desktop images. AnyDesk claims up to 60 fps, under 16 ms on a LAN, usable at about 100 kB/s. These are vendor numbers. DeskRT is not public; we should use H.264 with VideoToolbox hardware decode on iOS and WebCodecs or JPEG tiles in the browser.

---

## (a) Gestures per mode

### AnyDesk

| Action | Touchpad / mouse mode (AnyDesk) | Touch mode (AnyDesk) | Source |
|---|---|---|---|
| Move pointer | One-finger swipe anywhere (relative) | Pointer jumps to the finger | Official Android page |
| Left click | Tap (lands at the cursor, not the finger) | Tap at the finger | Official Android page; touch mode not documented in detail |
| Right click | Tap and hold | Not documented | Official Android page; Alphr says same on iOS |
| Middle click | Three-finger tap | Not documented | Official Android page |
| Scroll | Three-finger swipe | Not documented | Official Android page; Android 6.0.0 fixed "3-finger scroll in touchpad mode" |
| Zoom | Two-finger swipe / pinch | Not documented | Official Android page |
| Drag / select | Double-tap, hold on the second tap, then move | Not documented | Alphr (third-party) |
| Double click | Not documented | Not documented | — |
| Two-finger tap | **Not documented as right click** in AnyDesk | — | No source found |
| Mouse events as touch | Option "Translate mouse input to touch input" (Android 6.1.2) | — | Official |

Notes:
- AnyDesk uses **two fingers for zoom** and **three fingers for scroll**. Most other products use two fingers for scroll. This frees two fingers for pinch with no conflict. It is unusual, and an App Store review complains that "holding and dragging with the touchpad controls" is the weak point.
- An old iPad review (2020) describes the default touch mode as: hold on the remote cursor, drag it, then double-tap to click. Whether current iOS touch mode still works that way is **not confirmed**.
- Android "Touch to touch mode" is direct interaction and is the default for Android-to-Android only.

### What the others do (for the parts AnyDesk does not document)

| Action | Microsoft RD, mouse pointer | Chrome Remote Desktop, trackpad | Screens 5 | RustDesk mouse mode | RustDesk touch mode |
|---|---|---|---|---|---|
| Left click | Tap | Tap | Tap | One-finger tap | One-finger tap |
| Right click | Two-finger tap, or tap and hold | Two-finger tap | Two-finger tap | Long press, or two-finger tap | Long press |
| Middle click | — | Three-finger tap | Three-finger tap | — | — |
| Drag | Double-tap and hold, then drag | Press and hold until a gray circle shows, then drag | Long press and drag (blue indicator) | Double tap and move | One-finger move |
| Right-drag | Double-tap and hold with two fingers | — | Two-finger long press (red) | — | — |
| Scroll | Two-finger tap and hold, then drag | Two-finger swipe | Two-finger swipe | Three-finger vertical | Three-finger vertical |
| Zoom | Pinch | Pinch | Pinch | Pinch | Pinch |
| Pan the view | — | — | — | Two-finger move | Two-finger move |
| Double click | — | — | Double-tap | — | — |

Microsoft Direct touch: tap = left click, tap and hold = right click, no pointer shown.

**Consensus to copy:** tap = left click, two-finger tap = right click, long press also = right click, three-finger tap = middle click, pinch = zoom, two-finger drag = scroll, double-tap-and-hold = drag. AnyDesk's three-finger scroll is the outlier; I recommend two-finger scroll plus pinch, separated by whether the finger distance changes.

---

## (b) Zoom, pan and cursor rules

### Confirmed for AnyDesk
- Pinch (two fingers) zooms. The zoom range is **not documented**.
- View modes on desktop: "Original" (1:1, with edge scrolling), "Shrink" (fit without distortion), "Stretch" (fill, may distort). There is also "Auto-adapt resolution", which resizes the remote display to the client window and restores it on session end. Whether all of these appear on the phone is **not confirmed**.
- Android Settings > Display offers quality choices described as "best reaction time, balanced, original".
- Touchpad mode draws a **local cursor** (iOS 4.1.0). The remote cursor can be shown or hidden in iOS settings.
- "Follow remote cursor" was added to iOS Session Settings in 8.3.0 (Oct 7, 2026). The exact behaviour is not described. The name suggests the zoomed view pans to keep the remote cursor in view.
- Since iOS 7.1.0 the cursor shows when an action is not allowed on the remote side (a "forbidden" cursor).
- Android auto-switches to the monitor that holds the focused window (6.1.4).

### Not confirmed for AnyDesk
- Double-tap to zoom or to fit.
- Pointer acceleration in touchpad mode.
- Whether the cursor size can be changed. An App Store review says AnyDesk does not show custom cursor shapes.

### Rules to implement (from AnyDesk where known, RustDesk source where not)

RustDesk is open source, so its exact logic is a good reference (`flutter/lib/models/model.dart`, `CursorModel.updatePan`):
1. In touchpad mode, cursor movement = finger delta divided by the zoom scale. No acceleration in RustDesk.
2. **Auto-pan:** when the cursor moves past the centre of the visible area toward an edge, and there is more desktop beyond that edge, the **view pans and the cursor stays put on screen**. When the view hits the desktop edge, the cursor moves on to the edge. This keeps the cursor near the middle while you explore a zoomed desktop.
3. If a touchpad drag starts while the cursor is off-screen, RustDesk first moves the cursor to the centre of the view.
4. Two-finger move pans the canvas; pinch zooms around the pinch centre.

Recommended defaults for us:
- Start at "fit to screen". Allow zoom from fit up to about 4x of 1:1 pixels (my recommendation; AnyDesk's range is unknown).
- Double-tap with two fingers or a toolbar button toggles fit vs 1:1 (Screens uses two-finger double-tap for fullscreen; pick one and document it).
- Light acceleration in touchpad mode is optional. Start with RustDesk's linear mapping and add a small gain at high finger speed if testing shows it helps.
- A setting "follow cursor" (on by default) for auto-pan.
- Clicks in touchpad mode land at the cursor, never at the finger. In touch mode the click lands at the finger, mapped through the current zoom and pan.

---

## (c) Keyboard and special keys

### Confirmed for AnyDesk
- iOS: the menu has "Show the virtual keyboard", with standard and special modes (special = F-keys, Ctrl and similar). A "new special keyboard" shipped in iOS 7.0.3 (Apr 2023).
- Android input types: special keyboard (F1, Windows key, Tab and so on), the installed Android keyboard, and an automatic keyboard toggle. Android 8.0.4 opens the soft keyboard "more reliably when input is possible" on Windows targets, so AnyDesk opens the keyboard automatically when a text field is focused.
- Ctrl+Alt+Del: Actions menu on iOS and Android (Windows targets only).
- iOS hardware keyboards: display bug fixes when a hardware keyboard is attached (4.1.1), Magic Keyboard support (5.2.0), different hardware keyboard language layouts (7.0.1), improved Korean input (7.1.2).
- Keyboard translation on desktop: "Auto" (default), "Remote" (by physical key position), "Local" (by local layout). Not confirmed on the phone.

### Not confirmed for AnyDesk
- Exact key list on the special bar.
- Whether modifiers latch (one-shot), lock (double-tap), or must be held.
- Whether typed text is sent as characters or as key events.
- Mouse support on iPad (iPadOS pointer). A 2020 review said it was not supported; no later changelog entry says it was added.

### Recommended for us
- Toolbar keyboard button opens the soft keyboard. Above it, a scrollable key strip: Esc, Tab, Ctrl, Alt, Shift, Win/Cmd, arrows, Home/End, PgUp/PgDn, Del, F1–F12, and a Ctrl+Alt+Del button (Windows targets).
- Modifiers: one tap latches for the next key, double-tap locks, tap again releases. Show the state clearly. (Common pattern; not confirmed in AnyDesk.)
- Printable text from the soft keyboard is sent as Unicode text, not key codes, so any language and IME composition works. Special keys and shortcuts go as key events.
- iPad and iPhone hardware keyboards: forward key events with layout handling; map Cmd to Win on Windows targets; capture Cmd+Tab where iOS allows it.
- iPadOS mouse/trackpad: use pointer lock where available so the remote cursor moves directly.

---

## (d) Menu and extra functions, and how they are revealed

### AnyDesk, confirmed
- **iOS:** swipe in from either screen edge to open the session menu.
- **Android:** a floating AnyDesk logo. Long-press opens the pie menu; double-tap and drag moves the logo. Five tiles: Settings, Input type, Monitor selection, Actions, Close session. Android 6.2.2 fixed a conflict between the system back gesture and the pie menu.
- **iOS Settings:** transmission quality; enable or disable remote control (view-only); clipboard sync; block the remote user's input; touch or touchpad input; screen privacy mode; show or hide the remote cursor; follow remote cursor (8.3.0).
- **Monitor switching:** a menu tile. iOS supports up to 16 monitors (4.0.0).
- **Actions (iOS):** chat, Ctrl+Alt+Del, screenshot, UAC elevation request, system information, start/stop session recording.
- **Actions (Android):** Ctrl+Alt+Del, UAC elevation, screenshots, VPN, session recording, audio and display settings, monitor switching, fullscreen toggle (Android 5.0.0), end session.
- **Desktop Actions also include:** restart remote device, lock device, switch user, sign out, "Insert from clipboard". Restart is confirmed on Android for macOS with FileVault (7.3.0); not confirmed on iOS.
- **File transfer:** in-session file manager (Android 7.2.0), to and from iOS (5.1.0), drag and drop between apps (iOS 7.0.0), share-sheet extension (iOS 5.2.0).
- **External monitor:** the iOS client supports external monitors (5.5.0).
- **Clipboard:** sync toggle; Android splits text and file clipboard permissions (7.1.0).
- **Leaving the app:** on an iOS device being viewed, the session closes after a 5-second warning when the app is left. Behaviour for the controlling side in background is not documented.

### Not confirmed for AnyDesk
- Remote resolution change from the phone.
- Orientation lock options.
- Audio on/off from the phone (Android lists "audio settings").
- How iOS system gestures (home bar, notification pull-down) are reserved. Microsoft offers "Use Home Indicator Area"; iOS apps can ask the system to defer edge gestures.

### Recommended for us
- One small floating button (draggable, snaps to edges, semi-transparent) plus edge swipe. Tapping it opens a bottom sheet with: keyboard, input mode, monitors, quality, view mode (fit / 1:1), clipboard, files, Ctrl+Alt+Del and other actions, disconnect.
- Hide all chrome by default (immersive). Use `preferredScreenEdgesDeferringSystemGestures` and hide the home indicator during a session so edge swipes reach us first.
- Landscape and portrait both work; rotating keeps the zoom centre.

---

## (e) What to build to match AnyDesk

### Must-have (native iOS)
- [ ] Two input modes, switchable in session: touch (tap where you want) and touchpad (relative cursor). Remember the choice per device.
- [ ] Gestures: tap = left click; two-finger tap and long press = right click; three-finger tap = middle click; double-tap-and-hold = drag; two-finger drag = scroll; pinch = zoom.
- [ ] Local cursor overlay drawn by the client in touchpad mode, moved instantly; corrected by the remote cursor position when it arrives.
- [ ] Clicks in touchpad mode land at the cursor.
- [ ] Zoom from fit to at least 3–4x of 1:1, with pan; auto-pan that follows the cursor (RustDesk centre rule).
- [ ] Fit-to-screen and 1:1 toggle.
- [ ] Soft keyboard button plus special-key strip with latching modifiers; Ctrl+Alt+Del.
- [ ] Unicode text input (any language).
- [ ] Hardware keyboard support with key events.
- [ ] Session menu: floating button and edge swipe; disconnect; monitor switch.
- [ ] H.264 decode with VideoToolbox, low-latency (no B-frames, decode-on-arrival, no jitter buffer beyond one frame).
- [ ] Connection quality indicator and automatic reconnect after a network change (AnyDesk Android 4.0.2 "improved reconnect on network change").

### Must-have (mobile browser viewer)
- [ ] Same gesture map, built on Pointer Events with `touch-action: none` on the canvas.
- [ ] Local cursor overlay.
- [ ] Zoom and pan done in our own transform, not the browser's page zoom (disable page zoom with the viewport meta tag).
- [ ] Hidden text input to raise the soft keyboard, plus an HTML special-key strip; send `input` event text as Unicode.
- [ ] Video: WebCodecs H.264 where supported (Safari 16.4+), JPEG or WebP tiles as fallback.
- [ ] Clear toolbar button for the menu (edge swipes in Safari collide with back/forward).

### Should-have
- [ ] Quality setting: best quality / balanced / best performance (AnyDesk's names).
- [ ] View-only toggle.
- [ ] Clipboard sync (text first).
- [ ] Follow-cursor setting and show/hide remote cursor setting.
- [ ] Three-finger tap = middle click; right-drag.
- [ ] iPad pointer and trackpad support (pointer lock).
- [ ] Screenshot of the remote screen.
- [ ] Block remote input / privacy screen (needs host support).
- [ ] Immersive mode: hide home indicator, defer edge gestures.
- [ ] Gesture help screen (RustDesk and TeamViewer both show one).
- [ ] Address book / recent devices with online state.

### Later
- [ ] File transfer and file manager.
- [ ] Chat.
- [ ] Session recording.
- [ ] Remote audio.
- [ ] Restart remote, lock, sign out, UAC elevation.
- [ ] Remote resolution change and auto-adapt resolution.
- [ ] External monitor output on iPhone, with the phone becoming a touchpad (Microsoft does this automatically).
- [ ] Keyboard translation modes (auto / local / remote).
- [ ] Relative mouse mode for games (RustDesk 1.4.5).

---

## (f) Performance: what AnyDesk claims and what is realistic for us

AnyDesk (vendor claims): DeskRT is a proprietary codec built for desktop images (flat colour, sharp edges, repeated patterns). It sends only changed regions. It runs image processing on multiple cores. AnyDesk advertises 60 fps, under 16 ms latency on a LAN, and smooth use at about 100 kB/s. An older independent review measured near 60 fps. iOS 8.0.0 moved rendering from OpenGL to Metal. The Android app "adapts video quality to actual needs" (8.5.0). No public DeskRT specification exists.

Realistic for us:
- **iOS native:** H.264 (or HEVC) decoded by VideoToolbox in hardware; render with `AVSampleBufferDisplayLayer` or Metal. 60 fps at 1080p is easy for any recent iPhone. Keep latency low with a low-latency encoder setting (no B-frames, short GOP or intra refresh), and adapt bitrate and frame rate to measured round-trip time and loss.
- **Browser:** WebCodecs `VideoDecoder` for H.264 where available; fallback to JPEG/WebP dirty-rectangle tiles. JPEG tiles cost more bandwidth but are simple and work everywhere.
- **Feel matters more than frame rate:** the local cursor overlay and instant local zoom/pan hide most network latency. This is the main trick to copy.
- Adaptive quality: drop frame rate first, then resolution, then bitrate, and say so in the quality indicator.

---

## Could not confirm (do not treat as AnyDesk behaviour)

- AnyDesk zoom range, double-tap-to-zoom, and pointer acceleration.
- Exact behaviour of "follow remote cursor".
- Whether two-finger tap is right click in AnyDesk (it is in most other apps; AnyDesk documents hold).
- Exact special-key list, modifier latching, and text-vs-keycode input.
- Current iOS touch mode details; the 2020 "drag the cursor, then double-tap to click" description may be outdated.
- iPadOS mouse/trackpad support in the current app.
- Remote resolution change, orientation options, audio, and restart remote on iOS.
- How AnyDesk shows connection quality and what it does on disconnect on mobile beyond "reconnect" (Android has a reconnect button, 8.0.4).
- Any number for DeskRT beyond AnyDesk's marketing.

---

## Sources

AnyDesk official
- AnyDesk for iOS, iPadOS and tvOS: https://support.anydesk.com/docs/anydesk-for-ios-ipados-tvos.md
- AnyDesk for Android: https://support.anydesk.com/docs/anydesk-for-android.md
- Display (quality and view modes): https://support.anydesk.com/docs/display.md
- Keyboard and hotkeys: https://support.anydesk.com/docs/keyboard-hotkeys.md
- Session settings: https://support.anydesk.com/docs/session-settings.md
- Documentation index: https://support.anydesk.com/llms.txt
- iOS changelog: https://anydesk.com/en/changelog/ios (mirror read: https://anydesk.com.cn/en/changelog/ios)
- Android changelog (mirror read): https://anydesk.com.cn/en/changelog/android
- App Store listing: https://apps.apple.com/us/app/anydesk-remote-desktop/id1176131273
- Performance page: https://anydesk.com/en/performance

Third-party on AnyDesk
- Alphr, right click in AnyDesk: https://www.alphr.com/anydesk-right-click/
- TSplus, typing in AnyDesk mobile: https://tsplus.net/remote-support/blog/how-to-type-in-anydesk-mobile-practical-guide/
- The Sweet Setup, AnyDesk review (2020): https://thesweetsetup.com/apps-were-trying-anydesk/
- Neowin AnyDesk release notes (DeskRT, 60 fps): https://www.neowin.net/software/anydesk-230/
- ScienceSoft performance report: https://www.scnsoft.com/files/performance-testing/performance-testing-report-anydesk.pdf

Other products
- Microsoft Remote Desktop for iOS/iPadOS features and gesture table: https://learn.microsoft.com/en-us/azure/virtual-desktop/users/client-features-ios-ipados
- Chrome Remote Desktop help: https://support.google.com/chrome/answer/7378542?hl=en
- Screens 5 cursor control and gestures: https://help.edovia.com/en/screens-5/features/cursor-control-modes-and-other-gestures
- Splashtop iOS gestures: https://support-splashtoppersonal.splashtop.com/hc/en-us/articles/7082442827035 (blocked to direct fetch; content from search summary)
- Jump Desktop controls and gestures: https://support.jumpdesktop.com/hc/en-us/articles/216423503-Getting-Started-Jump-Desktop-Controls-and-Gesture-Reference (blocked to direct fetch)
- TeamViewer touch vs mouse on Android: https://www.teamviewer.com/th/global/support/knowledge-base/teamviewer-classic/mobile/android/touch-interactions-vs-mouse-interactions-on-android
- RustDesk Android docs: https://github.com/rustdesk/doc.rustdesk.com/blob/master/content/client/android/_index.en.md
- RustDesk gesture help (source): https://github.com/rustdesk/rustdesk/blob/master/flutter/lib/mobile/widgets/gesture_help.dart
- RustDesk touch input (source): https://github.com/rustdesk/rustdesk/blob/master/flutter/lib/common/widgets/remote_input.dart
- RustDesk cursor and auto-pan (source, `CursorModel.updatePan`): https://github.com/rustdesk/rustdesk/blob/master/flutter/lib/models/model.dart
- RustDesk 1.4.5 relative mouse mode: https://ubuntuhandbook.org/index.php/2026/01/rustdesk-1-4-5-released-with-new-relative-mouse-mode/
