---
title: "Normal-Chrome browser skill: the Linux driver, first slice (agent display, AT-SPI reading, guarded clicks)"
slug: "normal-chrome-linux"
author: "echo"
parent-principle: "Self-Unblock Before Escalating"
eli16-overview: "normal-chrome-linux.eli16.md"
lessons-engaged: >
  P1 Structure > Willpower (every rule this slice adds is code in the wrapper xdrive.sh or the driver x-drive.py,
  never prose: the agent-owned display, profile jail, url rule, outfile rule, environment allowlist for Chrome,
  per-agent lock, binding, focus check before every keystroke, hit-test before every click, unknown-outcome latch,
  no typed text on argv; the threat model states these are guardrails against an honest agent's mistakes, not a
  boundary against same-user code); "Cut to five floors when it keeps biting" (a shared-display design took six
  review rounds and an agent-display design with a phone handover two more; this slice keeps the agent display and
  the security floors and ships launch, read, find-and-click, type, navigate, Secret Drop passwords and a boot install, with everything else in a
  tracked list); P2 Signal vs Authority and "A Decision That Can Block Must Live Where the Checks Can See It" (both
  new files enter the blocking-decision lint's population, which widens to .py, declared and content-pinned; every
  refusal is classified in the decision table); P3 Migration Parity (the scripts ride the always-overwrite
  installer; the skill text and the CLAUDE.md card change through hash-gated PostUpdateMigrator branches); P4
  Testing Integrity (three tiers plus a live gate with verdict rules); P5 Agent Awareness (the card and the skill
  name all three platforms and what the Linux slice can and cannot do); P11 / P12 A Wall Is a Hypothesis / Never a
  False Blocker (the "Linux: not built" wall was tested on a real Linux desktop on 2026-11-03 and does not hold);
  P14 Distrust Temporary Success (a click's exit code is delivery, never outcome; the proof's first link click
  "succeeded" and changed nothing); P19 No Unbounded Loops (every wait has a named bound and a timeout is an
  unknown outcome); P24 Never Silently Cut the Data a Decision Depends On (truncation and incomplete search are
  disclosed with exit 3 and refuse a click); P20 Verify the State, Not Its Symbol (a table names symbol, state,
  corroboration and the unmeasurable result for every check); P21 Multi-machine (line-leading markers below);
  the operator's rule of 2026-10-13 that Instar runs on at least Mac and Linux (ACT-138); Mobile-Complete Operator
  Actions (this slice asks nothing of the operator but a reply in chat: no handover, no viewer; the phone watch and
  take-over path is a later slice); L6 side-effects review; L9 ELI16 companion.
approved: true
approved-by: "echo, on the desk's brief for topic 138429 (136110, ledger .instar/vm-test/app-coordination.md, 2026-11-04 20:31 PST: 138429 owns ACT-138, v1 slice from draft #2676) and Justin's standing rule of 2026-10-22 08:58 PDT that he approves only constitution changes. This spec touches no constitution file. Justin did not read this spec."
review-convergence: "2026-11-05T05:12:29.394Z"
review-iterations: 6
review-completed-at: "2026-11-05T05:12:29.394Z"
review-report: "docs/specs/reports/normal-chrome-linux-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Normal-Chrome browser skill: the Linux driver, first slice

## Glossary

- **The skill:** `/normal-chrome-browser`, the built-in skill specified by `docs/specs/normal-chrome-builtin-skill.md` (macOS) and `docs/specs/normal-chrome-cross-platform.md` (macOS + Windows). This spec is the first Linux slice.
- **X11 / XTEST:** the classic Linux display system and its extension for injecting keyboard and mouse input; to the browser, XTEST input arrives exactly like a physical keyboard's.
- **Wayland:** the newer Linux display system. It does not let one program inject input into another's window. This slice never uses the session's display, so a Wayland desktop does not affect it; a Wayland input backend is a later slice.
- **AT-SPI:** the Linux accessibility bus (the thing screen readers use). Chrome publishes its page as a tree of named, role-tagged objects with rectangles when accessibility is switched on.
- **The agent display:** a virtual X server (TigerVNC's `Xvnc`) that the driver starts for one agent, with its own cookie, session D-Bus and AT-SPI bus. Nobody else types on it, and in this slice nobody watches it.
- **The input backend:** the one small interface (below) through which every pointer move, click, keystroke and coordinate conversion passes. This slice ships the X11 backend.
- **Cirrus:** the operator's paired Instar test agent on a Hetzner Ubuntu 24.04 VM, with a TigerVNC user service (`vnc-display1`) running an XFCE desktop on `DISPLAY=:1`. Used for the proof below.
- **xdrive.sh / x-drive.py:** the Linux wrapper (the Instar entry point, bash) and the driver (python3, one command per invocation). They mirror `ndrive.sh` / `native-drive.ps1`.

## Problem statement

The skill's shipped text says Linux "with no Windows underneath" is not built: `chrome-launch.sh`, `chrome-js.sh`, `chrome-mainworld.sh`, `chrome-close.sh`, `chrome-renew.sh` and `chrome-unsaved.sh` stop with `ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on Linux`, and `ndrive.sh` stops with `ERR windows-only: ndrive.sh runs native-drive.ps1 through powershell.exe from WSL ...`. An agent on a Linux machine (a cloud VM such as Cirrus, a Linux laptop) therefore cannot do any task that needs a normal Chrome, and the skill tells it to say so and stop. The operator's rule is that Instar runs on at least Mac and Linux; ACT-138 ("Linux path for the normal-Chrome browser skill", due 2026-11-18) is the recorded item for closing this.

The method was named in `.instar/vm-test/README.md`: a normal Chrome; input via real X events; page reading via the AT-SPI tree (Chrome started with `--force-renderer-accessibility`); no CDP or remote-debugging port. This spec measures that method on a real Linux desktop and turns the smallest useful part of it into a driver: start Chrome on a display the agent owns, read the page, find an element by name and click it after a hit-test, type ordinary text, and navigate.

## The measured proof (Cirrus, 2026-11-03, 22:23-22:31 UTC)

Host: Cirrus, Ubuntu 24.04, session type `XDG_SESSION_TYPE=x11`, XFCE on TigerVNC `DISPLAY=:1` (1600x1000), Google Chrome 156.0.8078.79, xdotool 3.20160805.1, python3-gi 3.48.2. Throwaway profile `~/.config/chrome-act138-test`, public pages only (example.com, iana.org, en.wikipedia.org, one `data:` page I wrote), no sign-in. The Chrome I started was killed and its profile deleted at the end; no other process or service was touched. The proof helpers (`atspi-probe.py`: `apps`, `tab`, `text`, `find`, `at`, `tree`; `gclick.sh`: find, hit-test, active-window check, click) were copied to `/tmp` and removed afterwards.

### Step 0: prerequisites (one snag)

`python3-gi` was installed but the AT-SPI typelib was not: `gir1.2-atspi-2.0` and `python3-pyatspi` were missing. The `instar` user has passwordless sudo on Cirrus, so `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y gir1.2-atspi-2.0 python3-pyatspi` installed them (4.2 s). The desktop's session bus was not in the ssh shell's environment; it was read from the XFCE session process: `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-7VPaByoIqu,...` (from `/proc/<xfce4-session pid>/environ`); the root window carries `AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_1,..."`. `org.a11y.Status IsEnabled` and `ScreenReaderEnabled` were both `false`.

### Step 1: launch, and the accessibility switch (one snag)

```
google-chrome --user-data-dir=$HOME/.config/chrome-act138-test --password-store=basic --no-first-run \
  --no-default-browser-check --force-renderer-accessibility --new-window https://example.com/
```

The window appeared after 1.07 s (`Example Domain - Google Chrome`), but Chrome did **not** register on the AT-SPI bus (`apps` listed xfce4-session, xfwm4, Thunar, ... and no Chrome). `--force-renderer-accessibility` builds the page tree; the likely reason (a hypothesis until the live gate's A/B row) is that the browser process only connects to AT-SPI when it thinks assistive technology is on. Relaunching with **`ACCESSIBILITY_ENABLED=1`** in Chrome's own environment fixed it without changing any session-wide setting: Chrome registered after **0.47 s** (`16 'Google Chrome' 55792`).

### Step 2: read the active tab (URL, title, text)

```
$ python3 atspi-probe.py tab 55792          # 81-137 ms on example.com
FRAME 'Example Domain - Google Chrome' True
OMNIBOX 'Address and search bar' 'example.com'
DOC 'Example Domain' True {'Title': 'Example Domain', 'MimeType': 'text/html', 'URI': 'https://example.com/'}
FRAME '' False
DOC '' True {'Title': '', 'MimeType': '', 'URI': ''}
```

Two sources of the URL: the omnibox text (a display string, scheme hidden, like Windows) and the document's `URI` attribute (the full committed URL, scheme included). The second is better than anything the Windows driver has. The app also exposed two extra frames with empty documents; a driver must scope to the frame in the `active` state that belongs to the bound window. `text` returned the page's paragraphs (example.com's text in six languages) in 71 ms.

### Step 3: click a link found through AT-SPI

```
$ python3 atspi-probe.py find 55792 "learn more"
HIT link 'Learn more' extents (481, 928, 93, 20) True True        # role, name, screen x,y,w,h, showing, visible
$ xdotool getactivewindow   -> 46137347 (pid 55792, our Chrome)
$ xdotool mousemove --sync 527 938 click 1
click -> new document in 675 ms
DOC 'Example Domains' ... 'URI': 'https://www.iana.org/help/example-domains'
```

Page text read back from iana.org (`Example Domains`, `A number of domains such as  and  are maintained ...`). The empty gaps are a snag: inline links are embedded objects (U+FFFC) inside the paragraph's text, and the quick probe dropped them; the driver must expand them through the Hypertext interface.

### Step 4: navigate by keyboard

```
$ xdotool key --clearmodifiers ctrl+l; xdotool type --delay 12 "https://en.wikipedia.org/wiki/Accessibility"; xdotool key Return
nav -> document in 2624 ms
FRAME 'Accessibility - Wikipedia - Google Chrome' True
OMNIBOX 'Address and search bar' 'en.wikipedia.org/wiki/Accessibility'
DOC 'Accessibility - Wikipedia' True {... 'URI': 'https://en.wikipedia.org/wiki/Accessibility'}
```

### Step 5: the click that changed nothing (the most important snag)

`find` returned `link 'assistive technology' extents (253, 541, 144, 18)`; the click at (325, 550) landed, exit 0, and the page did not change. The screenshot showed why: after the extents were read, Wikipedia inserted a donation banner at the top and pushed the article down by about 355 px. The click hit empty space. Re-reading gave the link at (253, 896); the new `at` hit-test (AT-SPI `get_accessible_at_point` at the click point, walked down to the deepest child) answered:

```
at 325 550 -> landmark:'' < section:''
at 325 905 -> static:'assistive technology' < link:'assistive technology' < paragraph:'' < ...
```

With the guard (find showing-only element, hit-test the centre, check the active window, then click):

```
CLICKED 325,905 -> document in 2380 ms
DOC 'Assistive technology - Wikipedia' ... 'URI': 'https://en.wikipedia.org/wiki/Assistive_technology'
```

The same step also showed that `find` on a large page returns off-screen matches (extents y=2673, 8267, 15410 with `showing=False`): the driver must refuse to click those, or scroll first.

### Step 6: a button and a text field

```
CLICKED 728,522 (link 'Search')                       # opens Wikipedia's search field
FOCUSED combo box 'Search Wikipedia'                  # read from the tree's focused state
xdotool type --delay 15 "screen reader"
CLICKED 703,164 (push button 'Search' extents (668, 148, 71, 32))
button -> document in 4659 ms
DOC 'Screen reader - Wikipedia' ... 'URI': 'https://en.wikipedia.org/wiki/Screen_reader'
```

### Step 7: the input is real input

A `data:` page typed into the omnibox carried one button whose click handler wrote `T` or `F` (the event's `isTrusted`) plus `clientX` into its own label. After a guarded `xdotool` click the tree read `push button 'T45'`: the page saw a trusted click. `xdotool` without `--window` injects through XTEST, the same path as a physical device; with `--window` it uses `XSendEvent`, which marks the event as synthetic, so the driver never passes `--window` to an input command.

### Step 8: operator-idle and window-only screenshot

The X session's idle time is readable without new packages through `libXss.so.1` (`XScreenSaverQueryInfo`, via python ctypes): `x-idle-ms 718` right after the driver's own input, so the driver must keep its own-input tick (as the Windows driver does) to tell its input from the operator's. `import -window 46137347 /tmp/act138-win.png` gave a 1050x953 PNG of the Chrome window only.

### Timings and costs

| Step | Time |
|---|---|
| launch to X window | 1.07 s |
| launch to AT-SPI registration (with `ACCESSIBILITY_ENABLED=1`) | 0.47 s |
| `tab` (whole-app walk), example.com | 81-137 ms |
| `tab` / `find` (whole-app walk), Wikipedia article | 0.7-1.6 s |
| hit-test `at x y` | ~50 ms |
| link click to new document | 0.68 s (iana), 2.4 s (Wikipedia) |
| keyboard navigation to new document | 2.6 s |
| button click to search result | 4.7 s |

Whole-tree walks are the cost: my first poll loop re-walked the Wikipedia tree every 250 ms and took 106 s to time out. The driver scopes every query to the active document and uses the AT-SPI Collection interface (`get_matches`) for `find`.

### Not tested in the proof

`invoke` through the AT-SPI Action interface (`do_action`); typing a value from stdin; the operator-idle refusal with a real person at the VNC viewer; a Wayland session; Chromium (snap or distro package); a non-US keyboard layout. Each is a row in the live test plan below, except Chromium, which the design refuses (`ERR unsupported-browser`, a unit test).


## Proposed design (v1 slice)

### What v1 does, and what it leaves for later

v1 is a driver that:
1. starts Chrome on the agent display, a virtual X server the driver owns;
2. reads the active tab (URL, title, text) through AT-SPI;
3. finds an element by its accessible name and clicks it, with a hit-test first;
4. types non-secret text and navigates;
5. types a password from Secret Drop into a password box, on the expected site only (`typesecret`, below);
6. arrives ready on a new Linux agent: the agent's own boot installs what it needs, with no manual step (below).

It **reads** through the accessibility tree and **acts** through real X input, so a click carries user activation. It has **no page-world JavaScript** (no Linux equivalent of macOS's "Allow JavaScript from Apple Events"; CDP, `--remote-debugging-port` and WebDriver are forbidden by the shared rules). When an operator task needs page JavaScript, a one-time code, a person's hands, a download or anything else in "Later slices", the agent says so plainly and stops.

### Where Chrome runs: a display the agent owns

The driver runs Chrome only on the agent display. It never sends input to, or reads, a display a person is using (the operator's desktop, Cirrus's `:1`, a Wayland login's Xwayland). Because no person shares the keyboard and pointer, the driver needs no operator-presence detection. In v1 nobody watches the agent display: it has no VNC listener at all.

**The stack.** On the first `launch`, under the per-agent lock, the wrapper starts three processes, each with `setsid`, under `env -i` with only `PATH`, `HOME`, `LANG` and the private addresses below:
1. `Xvnc` (resolved as `Xvnc` or `Xtigervnc`) on the first free display number from 100 to 119 (no `/tmp/.X11-unix/X<N>` socket and no `/tmp/.X<N>-lock` whose pid is alive; a start that loses the race tries the next number), with `-auth <cookie file> -nolisten tcp -rfbport -1 -SecurityTypes None -AcceptKeyEvents=0 -AcceptPointerEvents=0 -AcceptCutText=0 -SendCutText=0 -AcceptSetDesktopSize=0 -geometry 1600x1000 -depth 24`. No TCP port and no VNC socket, so no viewer can connect; the keyboard layout is the server's default `us`. TigerVNC is chosen over Xvfb so the later watch slice adds a viewer socket to the same server instead of a second program.
2. `dbus-daemon --session --nofork --address=unix:path=<sockets>/bus`, the agent display's own session bus.
3. `at-spi-bus-launcher --launch-immediately` (from `at-spi2-core`, at `/usr/libexec/at-spi-bus-launcher` or `/usr/lib/at-spi2-core/at-spi-bus-launcher`, never on PATH) with that `DISPLAY` and bus, and `XDG_RUNTIME_DIR` set to the socket folder so its socket lands there too. It starts the accessibility bus and sets `AT_SPI_BUS` on the root window. The wrapper then sets `org.a11y.Status IsEnabled=true` on this private bus, which no other application uses. Chrome also gets `ACCESSIBILITY_ENABLED=1` (the proven switch); the live gate runs each on its own.

The cookie (`.instar/state/xdrive/display/Xauthority`, 0600, in a 0700 folder) is a fresh random MIT-MAGIC-COOKIE-1 entry for this display number on the local host only (family local, never the wildcard), written by the driver from its own memory before the server starts; it never appears on a command line or in a log. The bus sockets live in `.instar/state/xdrive/run/` (0700), never in `$XDG_RUNTIME_DIR`, which logind deletes when the user's last login session ends. When that path would be longer than 100 bytes, they live in `/tmp/instar-xdrive-<uid>-<first 12 hex of sha256(agent home)>/`, created with `mkdir` 0700; an existing folder is used only if `lstat` shows a directory (not a symlink) owned by this uid with mode 0700, otherwise `ERR no-x-server: socket folder not ours`.

The stack is ready, within 10 s, when: our `Xvnc` is alive and `/tmp/.X<N>-lock` holds its pid; an X connection with the cookie succeeds and its peer (`SO_PEERCRED` on the Unix socket) is that pid, so another user's server squatting the number is never used; and the root window's `AT_SPI_BUS` address accepts a D-Bus connection. Otherwise the wrapper stops what it started and answers `ERR no-x-server: <which part>` (exit 2). A machine with no `Xvnc` gets the same refusal with the install hint.

**The record and the health contract.** Each process is written to the record as soon as it has a pid, and Chrome is bound as soon as it is spawned, before any wait, so a wrapper killed during a start is found by the next call, which stops or reuses what is recorded. The moment between a spawn returning and its record being written remains; a process lost there is an accepted edge, the same size as the gap before any click, and a reboot clears it. `.instar/state/xdrive/display.json` holds the display number, the boot id (`/proc/sys/kernel/random/boot_id`), the socket folder, and a list of processes, each with pid and start time (`/proc/<pid>/stat` field 22): the three started above plus every child of `at-spi-bus-launcher` read from `/proc/<pid>/task/*/children` once the stack is ready (the accessibility bus's own `dbus-daemon`). Every call checks: same boot id; every recorded process alive with its recorded start time; the readiness conditions above. All true → reuse. When `Xvnc` itself is gone (so every Chrome on it is already gone), or nothing is bound, any false check → the stack is stopped (below) and the record removed; `launch` then starts a fresh one, and every other command answers `ERR no-target`. When `Xvnc` is alive and a bound Chrome is running, a failed check of another part answers `ERR display-unhealthy: <which part>` (exit 2) and stops nothing, so unsaved input in that Chrome is never ended by a health check; `close` still works there (it needs only the binding and the X server, never the accessibility side, and `close --force` needs only the binding; neither is subject to the stack health check or the one-window rule), and once nothing is bound the next call stops the stack. After a reboot (boot id differs) nothing is signalled. The `launch` output reports `linger: yes|no|unknown` from `loginctl show-user`, and with `no` adds that the stack ends with the user's last login session when the agent runs inside one; the live gate measures both the agent's service and an ssh shell that logs out.

**Stopping.** Only processes in a record are ever signalled, and each only after its start time is re-read from `/proc` and matches: a mismatched or missing pid is skipped and never signalled. Stopping the stack is SIGTERM to each matching recorded process, SIGKILL after 5 s to any still matching, then removing the record and the socket folder's contents. Process-group numbers are never used to choose what to signal. `close` ends the last bound Chrome and then stops the stack. Processes the accessibility bus starts later by activation (such as `at-spi2-registryd`) exit when their bus is gone; the live gate checks that nothing using the stack's addresses survives a stop.

### The input backend (one small interface)

Every pointer move, click and keystroke, and every conversion between an AT-SPI rectangle and an input coordinate, goes through one class in `x-drive.py`:

| Method | X11 backend (v1) |
|---|---|
| `coordinate_type()` | `screen` (AT-SPI extents and hit-tests are asked for in screen coordinates) |
| `to_input_point(rect, window)` | the rectangle's centre, unchanged (the window sits at 0,0 on the agent display) |
| `focus_window(window)` / `focused_window()` | `XRaiseWindow` + `XSetInputFocus` / `XGetInputFocus` walked up to the client top-level |
| `move(point)` / `pointer_window()` | `XTestFakeMotionEvent` + `XSync` / `XQueryPointer`: the top-level window under the pointer and the pointer's root coordinates |
| `button(n, down)` / `key(keysym, down)` | `XTestFakeButtonEvent` / `XTestFakeKeyEvent`, keysyms looked up on the `us` keymap |
| `type_text(text)` | per character, the precomputed keycode and Shift state from the `us` map: Shift down when needed, key down/up, Shift up, all under the same focus checks; a character with no keycode is refused before anything is typed |
| `release_all()` | releases every key and button this process pressed and has not released |

Everything else (the AT-SPI reads, `find`, the hit-test, the latch, the records) is backend-free. A static check fails when a libX11 or libXtst call appears outside the backend class. A Wayland backend (a later slice) implements the same methods with `coordinate_type() = window`, `to_input_point` adding the window's position (AT-SPI boxes are window-relative on native Wayland), a virtual pointer for `move` and `button`, and `wtype` reading its text on stdin for keys; the evidence is ledger entry "136848 (Omarchy) 15:46" in `.instar/vm-test/app-coordination.md`.

### Passwords through Secret Drop

The person's password goes from their Secret Drop page into the password box. The agent does not choose where it goes, and the honest path never brings it into the agent's context, a command line or a log.

```
POST /secrets/request  {"label":"...","fields":[{"name":"password",...}],"browserHost":"accounts.example.com"}
XD_PROFILE=<id> node .instar/scripts/secret-drop-retrieve.mjs <token> password --browser
```

**The host lives on the request.** `browserHost` is stored with the Secret Drop request and shown on the form: "This will be typed into accounts.example.com." So the person sees the destination before they submit. The agent takes it from the operator's words, never from page text.

**A browser request has one exit.** The helper always peeks first, applies these rules, and only then consumes, so a stray `--consume` cannot destroy a password that was never typed. `--browser` reads `browserHost` from the retrieve response, runs `xdrive.sh typesecret <host>` with the value on stdin and `XD_SECRET_BROWSER=1` set, and consumes the submission only on exit 0. `--browser` on a request with no `browserHost` is refused. For a request carrying `browserHost`, the helper refuses stdout, `--run` and `--consume`, and `--names` omits lengths. `browserHost` is validated with the same host pattern as the driver, is refused together with `senderVerification` (no person sees a form there), and travels on `SecretSubmission` and `StuckConsumerEvent`. The `[secret-drop-received]` and `[secret-drop-stuck]` notices name only the `--browser` line. Such a submission is never copied to the durable store, so a refused password does not outlive the received-submission cap.

**Only `--browser` reaches `typesecret`.** `xdrive.sh` refuses `typesecret` without `XD_SECRET_BROWSER` (`ERR use-secret-drop-browser`). The helper also sets `XD_SECRET_RUN=1` on every `--run` child, and `xdrive.sh` refuses every command under that marker, so `--run` can neither pick a destination nor put a secret in a plain box.

`typesecret <expected-host>` runs under every input rule above (binding, latch, deadline, focus pin, stop on focus or load change, release on stop) and adds these:
- **The receiving document is the one checked.** Walk up from the focused element to its nearest document object. That document's `URI` must be `https` on the default port, and its host must equal `<expected-host>`: parsed hostname, lowercase, no trailing dot, ASCII, exact. So a cross-origin iframe's box inside a matching page is refused. An owner that cannot be read refuses. The check is repeated before every keystroke, and typing also stops on `document:load-start` or a `busy` state change as well as `load-complete`, counting only events on the element's own document chain, so an advert loading in another frame does not.
- **The focused element must be a `password text`.**
- **The field is cleared first.** After the destination check the driver sends Ctrl+A and Delete, then requires the element's character count to be 0 (`ERR field-not-empty`), so a retry after a stop never appends.
- **The value stays in the driver's memory.** All of stdin is read into a `bytearray`: one line, at most 4096 bytes, one trailing newline dropped. An empty, multi-line or oversized value is refused (`ERR bad-secret`), and so is a character with no key, before any key is pressed. The buffer is overwritten when typing ends. No error, log line or post-state carries the value, its length or a position.
- **Exit 0 means delivered in full.** After typing, the owning document's host, the focused element and the element's character count (compared in memory with what was typed, never printed) must all still hold. This shows every character reached the box, not that a page did not alter it. Otherwise `refused: the value did not arrive in full`, exit 2, and the submission is kept. Stopping partway is exit 2 too, and the agent reads the page before retrying, as the latch requires.
- **`typesecret` never presses Return.** Submitting is a separate `key Return` or `click`. The submission is consumed once typed, so a rejected sign-in needs a new Secret Drop; the skill says so.
- **The typed box stays masked.** Before the first key its accessible path and the document are recorded in the binding, and the record survives any failure until the document changes. While it holds, one shared rule covers every output path (`text`, `find`, the `click` candidate list, post-state): that element and every other editable field on the document print as `[password field]`, because a "show password" toggle can replace the node.

Every `launch`, with Chrome not yet running, sets `credentials_enable_service: false` and `profile.password_manager_enabled: false` in the profile's `Default/Preferences`, so no save-password bubble appears and no password is stored by Chrome. A sign-in is two steps: the email through `type`, the password through `typesecret`.

"Never in the agent's context" holds for an honest agent, as the threat model says: same-user code can call the retrieve route directly.

### Leaving a stuck page

v1 has no viewer, so "tell the operator" cannot be the only way out.
- `key Escape` is allowed when focus is in browser UI, and with more than one window showing. It can only cancel. No other input reaches browser UI.
- `close --force` ends the bound Chrome when `close` answers `ERR close-blocked`: SIGTERM then SIGKILL after 5 s to the bound pid only, its start time re-read first, and it prints that unsaved input in that window is gone. It is the agent's own private Chrome, with no person on that display.
- A human check still stops the task. The agent tells the operator and uses neither of these to get past it.

### Installing on a fresh agent

`xdrive.sh` never installs anything and never calls sudo; that rule stands. The agent's boot does the installing, and only where it is wanted.

**Who gets it.** The rule is one expression: `config.browser.linuxDriver.autoInstall ?? (auto-install.json browserAutoInstall === true)`, and never on a throwaway agent (`classifyLocation`, checked at boot).
- **New agents.** `markNewAgent` writes `.instar/state/xdrive/auto-install.json` with `{"browserAutoInstall": true}`. It is the single seam all four agent-creating paths (`init` three times, `setup`) already call. Because it returns early when `newAgentAt` is present, an agent created before this release can never gain the file. `state/xdrive/` is backup-blocked, so a restore cannot carry it to another machine.
- **Existing agents and joined machines.** Nothing is installed by an update. Root package installs need consent, and that is the reason, not the no-restriction rule. They receive the scripts and the skill, and the agent offers one plain yes/no when the operator asks for a browser task. A yes calls `POST /browser/linux/install` (bearer auth, `X-Instar-Request: 1`, `CAPABILITY_INDEX` prefix `/browser`), which writes `autoInstall: true` through `liveConfig.set` and starts the install at once, bypassing the backoff, with no restart, answering 202 with the decision and current `GET /browser/state`. It answers 409 when `autoInstall` is explicitly false or the agent is a throwaway. `autoInstall: false` is the stop for anyone, and only a person changes it back.

**When.** A `void` call after `server.start()` in `src/commands/server.ts`, so the port is bound first. `src/core/linuxBrowserProvision.ts` is all asynchronous. "Attempt" means one run of the install, recorded with the boot id. After a failure the next attempt waits 1 h, then 6 h, then 24 h, in-process and at server starts alike, so a restart does not re-download anything, and after six attempts it stops until an operator's yes. The attempt count is on disk, and the loop is a registered self-action controller proven to settle. A held lock is ordinary, because of the wait below.

**What runs.** `.instar/scripts/browser/xdrive-provision.sh <agent home>`, started detached with `setsid`, under an environment allowlist (`PATH`, `HOME`, `LANG`) and `nice -n 19`, so a server restart or update cannot kill it mid-dpkg. Its body is `main "$@"; exit`, so an update rewriting the file cannot disturb a running copy. It holds `flock -n .instar/state/xdrive/provision.lock` for its lifetime, and a per-uid host lock in `/tmp` around its steps, because the apt source, key and defaults are host-wide, so a second start simply exits; that lock, not a pid, is what "a live runner" means, and it is separate from `agent.lock`, which only the upgrade also takes. It writes `provision.json` itself, through a temporary file and `mv`. `linuxBrowserProvision.ts` starts it only when all of these hold, and otherwise records `skipped: <reason>` itself: Linux, `x86_64`, `/etc/os-release` says Ubuntu 24.04 (the measured line), `apt-get` exists, `sudo -n true` succeeds, and 3 GB of disk is free. Attempt counts live in `provision-backoff.json`, and an hourly in-process check picks up retries and upgrades on a machine that stays up. The runner's steps, each bounded by 10 minutes:
1. `sudo -n dpkg --configure -a`, retried every 30 s for up to 5 minutes while the lock is held;
2. `repo_add_once="false"` in `/etc/default/google-chrome`, so Chrome's package does not rewrite the source or add an unscoped key;
3. the signing key from `https://dl.google.com/linux/linux_signing_key.pub`; its primary fingerprint must equal `EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796` (read from that URL on 2026-11-04), and only that key is exported to `/etc/apt/keyrings/google-chrome.gpg`. A different fingerprint gives `failed: key` and installs nothing; a rotation ships as a new pinned value in a release;
4. `/etc/apt/sources.list.d/google-chrome.list` with `signed-by` that keyring; the package then replaces it with its own source and keyring, measured below;
5. `sudo -n apt-get -o DPkg::Lock::Timeout=300 update`;
6. `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y python3-gi gir1.2-atspi-2.0 libxtst6 tigervnc-standalone-server at-spi2-core dbus google-chrome-stable`.

Installing from the signed repository means apt verifies the package. Chrome also needs patching, and stock unattended-upgrades skips third-party sources, so at a server start with `ready`, at most once per 24 h and never while a live binding exists, the runner does `update` and `--only-upgrade google-chrome-stable`. The runner holds `agent.lock` for the upgrade, re-checks for a binding under it, and skips while any Chrome runs on the host, another agent's included, because the package is host-wide. A second agent launching in the moment an upgrade starts is an accepted edge: its launch fails cleanly and it retries. A failed upgrade keeps `ready` and records `upgradeFailed`.

**Result.** `.instar/state/xdrive/provision.json` holds `installing`, `ready`, `skipped: <reason>` or `failed: <step>`, with the time, boot id and attempt count. `GET /browser/state` and `browser` in `GET /capabilities` report the state below, labelled as of that time and for the answering machine only. Without `sudo -n`, or on another OS or arm64 (Google publishes no arm64 Chrome for Linux), the result names the reason and the agent tells the operator what to install, so "no manual step" means: on a new Ubuntu 24.04 amd64 agent whose user has passwordless sudo, which is what Instar's cloud agents are. No dashboard surface in v1.

### Browser awareness

An Instar agent always has a browser (operator, 2026-11-04: "we need VERY robust awareness that an instar agent should ALWAYS have browser access"). An agent that does not know this says "I can't", so the awareness is built in, not left to memory.

- **One source.** `browserCapability()` always answers one of `ready`, `installing`, `not-built`, `broken`, with `driver`, `reason`, `nextStep` and `asOf`. No code path answers null or "no browser". `not-built` means not installed on this machine yet, including a machine automatic install cannot serve; `broken` means an install failed or a package has gone. macOS and Windows-from-WSL answer `ready` with their driver.
- **Where it shows.** `GET /browser/state`, `browser` in `GET /capabilities`, and a Registry First row, "Can I use a browser?", in the template and through `migrateClaudeMd`.
- **Every session on a Linux server** starts with a `BROWSER:` line from the session-start hook: that it has a browser, the state, and the rule below. It reads the install's own file, so it works with the server down, and the hook is always overwritten on update, so existing agents get it.
- **The rule.** In the v3 card, the hook line and the skill: before saying a browser task can't be done, check `GET /browser/state` and follow `nextStep`.

### Threat model (what the rules are, and are not)

Every client holding the agent display's cookie can inject input and read any application's AT-SPI tree on it; every process of the same Linux user can read that user's files and `/proc/<pid>/cmdline` and `environ`; and the agent itself has a shell. The wrapper and driver are therefore **guardrails against an honest agent's mistakes** (wrong window, wrong page, a stale coordinate, text on argv), the posture `ndrive.sh` states for Windows, not a boundary against same-user code. The agent display narrows the exposure: its cookie is readable only by this user, it opens no TCP port and no VNC socket, and the person's own desktop programs never see its keystrokes. The profile directory is as safe as that user's files (password store below). The agent's HTTP file API never serves a profile or the driver's state: `.instar/state/playwright-profiles/` and `.instar/state/xdrive/` (with and without the `.instar/` lead) join `NEVER_SERVED_PREFIXES` in `src/server/fileRoutes.ts`; the profiles prefix keeps its trailing slash, so `state/playwright-profiles.json` is unaffected. Both script headers say this and name the governing standards.

### Command surface

All through `.instar/scripts/browser/xdrive.sh <cmd> [args]`. The wrapper runs `/usr/bin/python3 -I x-drive.py` under `env -i` with the agent display's `DISPLAY`, `XAUTHORITY` and bus plus `PATH`, `HOME`, `LANG` (the system interpreter in isolated mode, so a venv, `PYTHONPATH`, `GI_TYPELIB_PATH`, `LD_PRELOAD` or a file planted beside the script cannot replace `gi` or the X libraries by accident), with `gi.repository.Atspi` and ctypes `libXtst` / `libX11`, one command per invocation. The agent display runs no window manager; the driver raises and focuses the bound window itself.

| Command | What it does |
|---|---|
| `launch <profileId> <url> [--new]` | Starts the agent display if none is live. Resolves the profile to `.instar/state/playwright-profiles/<profileId>`; a missing folder → `ERR no-profile` unless `--new`, which creates it 0700; `--new` on an existing folder → `ERR profile-exists`. Execs `/opt/google/chrome/chrome` (resolved from `google-chrome` / `google-chrome-stable`; any other binary → `ERR unsupported-browser`) with `--user-data-dir=<dir> --password-store=basic --ozone-platform=x11 --no-first-run --no-default-browser-check --force-renderer-accessibility --window-position=0,0 --window-size=1600,1000 --new-window <url>`, under `env -i` with only the agent display's `DISPLAY`, `XAUTHORITY` and `DBUS_SESSION_BUS_ADDRESS`, `HOME`, `PATH`, `LANG`, `LC_*` and `ACCESSIBILITY_ENABLED=1`, detached with `setsid`. Binds the browser pid (the process whose `/proc/<pid>/cmdline` carries that `--user-data-dir` and no `--type=`), its start time in `.instar/state/xdrive/targets/<profileId>.json` as soon as it is spawned, adds its X window when that appears, then waits up to 10 s for its AT-SPI app (matched by pid); if none appears, that pid is stopped and the answer is `ERR no-atspi`, so no unbound Chrome is left behind. The same Chrome already bound → `ALREADY-RUNNING`; any other Chrome on that profile → `ERR profile-in-use`, never driven or killed. Records the launch in the browser ledger (`chrome-ledger.sh`). |
| `url` / `title` | The active document's `URI` attribute (redacted, below) plus the omnibox string / the document title. |
| `text <outfile>` | Visible text of the active document, embedded objects expanded through the Hypertext interface, UTF-8 without a BOM. A `document:load-complete` event of the top document, or its `URI` changing, during the walk → `ERR page-changed; read again` (exit 3), no file kept. The walk iterates the GLib main context every 500 nodes so the event checks fire, streams to a temporary file in `out/` and renames it at the end. It stops at 200000 nodes, 20 MB or the deadline minus 5 s, and then ends `TRUNCATED at <n> nodes (<reason>); the rest of the document was not read` with exit 3. The value of a `password text` element is never read: it appears as `[password field]`. |
| `find <name> [role]` | Showing elements of the active document whose name contains the text, numbered, with centre and rect. Collection `get_matches` narrows by state `showing` and the role; names are fetched per candidate, at most 200 per call; past that → `INCOMPLETE: <k> of <m> candidates checked; add a role` (exit 3). When an element's accessible name differs from its visible text, both are printed and marked `name≠text`. |
| `click <name> [role] [index]` | `find`; an incomplete search → `ERR incomplete-search`; more than one match and no index → `ERR ambiguous-match` with the numbered list. Then, through the backend: the input point from the match's rect; refuse unless it lies inside the bound window; move the pointer there, wait 150 ms, hit-test (`get_accessible_at_point`, deepest child: the match or a descendant must be there), check the window under the pointer is the bound window and the pointer's root coordinates equal the point, check focus; press and release button 1. One re-find on a mismatch, then `ERR hit-test-mismatch`. A hit-test chain inside a browser-UI dialog, alert or bubble → `ERR browser-dialog-operator-only`. |
| `type` / `key <name>` | `type` reads its text from stdin and types it into the focused element, which must be an entry, combo box or editable text inside the active document and not a `password text` (`ERR secret-field-use-typesecret`); `key` sends one named key from a fixed list (`Return`, `Tab`, `Escape`, `BackSpace`, `Delete`, arrows, `Home`, `End`, `Page_Up`, `Page_Down`). `Escape` is allowed in browser UI; any other input there → `ERR browser-dialog-operator-only`. |
| `typesecret <expected-host>` | Reads ONE line from stdin and types it into the focused `password text` element. See "Passwords through Secret Drop". Any other focused element → `ERR not-a-password-field`; a document host other than `<expected-host>`, or a scheme other than https → `ERR host-mismatch`. Nothing about the value is printed. |
| `nav <url>` | Runs in phases, because it moves focus on purpose: pin the window, send Ctrl+L, then pin the omnibox in place of a page element and apply the per-keystroke checks to it. Ctrl+L, Ctrl+Shift+W in `close` and Escape are the only input sent to browser UI. So: Ctrl+L, then require the focused AT-SPI object to be the omnibox (otherwise `ERR browser-dialog-operator-only`, nothing typed), type the url, Delete (drops an inline autocompletion), Return; wait (15 s cap) for the active frame's `document:load-complete`; a `URI` change with no load event → `SAME-DOCUMENT`; neither → `NAV-TIMEOUT` (exit 3). Prints requested and final URI; a final host other than the requested one → exit 3 `nav-landed-elsewhere`. |
| `close [--force]` | Ctrl+Shift+W on the bound window, then wait up to 10 s for the bound pid to exit. A window still open (a "leave site?" dialog, unsaved input, a download) → `ERR close-blocked` (exit 2) naming what is open, nothing killed; `--force` then ends it (see "Leaving a stuck page"). Allowed under the latch. Binding removed when the process is gone; the last binding gone stops the stack. |

**One window, one tab per profile.** v1 drives the bound Chrome's single top-level window. Only mapped, non-override-redirect windows count, so omnibox suggestions and `<select>` lists do not. When the bound pid has more than one (a popup, a new window), input and reads answer `ERR multiple-windows` (exit 2). When the frame shows more than one tab (a `target=_blank` link), they answer `ERR multiple-tabs` (exit 2). `close` and `close --force` still work, and the agent relaunches. The active document is the AT-SPI frame of the bound app whose extents equal the bound X window's geometry and whose document has a non-empty `URI`; the frame's `active` state is corroboration only, since without a window manager Chrome may not set it. No such frame → `ERR no-active-document`.

**Post-state, not success.** Every input command ends by printing, 500 ms later, the active document's URI and title, the focused element (role and name) and whether the URI changed. The verdict word is `DELIVERED` (input sent, checks passed). With `XD_EXPECT=nav` the command waits for a new document (250 ms poll, 15 s cap) and answers `NAVIGATED` or `NO-NAVIGATION` (exit 3). Whether the operator's task succeeded is the agent's own read-back; an input command never reports a task as done.

**Page text is escaped, URIs are redacted.** Every page-derived string the driver prints has control characters, newlines and Unicode format and separator characters (Cc, Cf, Zl, Zp, incl. bidi overrides) escaped, so a page cannot forge a driver line such as `DELIVERED` or `ERR`. Every URI the driver prints or writes has the value of every credential-shaped query or fragment parameter (the url rule's list: code, token, key, secret, password, otp, auth, sig, ticket and variants, names percent-decoded before matching) replaced by `[redacted]`.

### Rules the wrapper and driver enforce

- **Platform.** `uname -s` must be `Linux` and `powershell.exe` must not be reachable (otherwise `ERR use-ndrive`). `DISPLAY`, `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` in the wrapper's own environment are ignored and never passed on.
- **Dependencies.** `/usr/bin/python3` with `gi` and the `Atspi 2.0` typelib, `libXtst.so.6`, `libX11.so.6`, `Xvnc` or `Xtigervnc`, `dbus-daemon`, `at-spi-bus-launcher`, `flock`, `timeout`, `setsid`, and `/opt/google/chrome/chrome`. A missing one → `ERR missing-dependency: <package>` with, on Ubuntu 24.04, the line `sudo apt-get install -y python3-gi gir1.2-atspi-2.0 libxtst6 tigervnc-standalone-server at-spi2-core dbus` (run verbatim in a clean Ubuntu 24.04 container by the live gate); elsewhere, package names as hints. The line is for Chrome-less hosts extended with the signed-repository step. The wrapper never installs anything and never calls sudo.
- **Chrome's environment.** `env -i` plus the `launch` allowlist: Chrome never inherits the agent's tokens or keys (`INSTAR_AUTH_TOKEN`, `BW_SESSION`, `GH_TOKEN`, provider keys) or a person's session addresses.
- **Password store.** Always `basic` (the private bus runs no secrets service). A profile's cookies are protected only by file permissions; the profile directory is created 0700 and a wider mode is refused (`ERR profile-permissions`). The skill and the `launch` output say this.
- **Flags.** Exactly the flags above; extra flags only through `XD_CHROME_FLAGS` with the Windows allowlist (`--disable-extensions`, `--window-size=W,H`, `--lang=xx`); anything else, in any spelling, is refused.
- **Profile jail.** `.instar/state/playwright-profiles/<id>` in this agent's home, id `^[a-z0-9-]{1,64}$`, realpath inside that folder (`ERR bad-profile-path` / `ERR profile-outside-agent-home`). Operator profiles (`~/.config/google-chrome*`, `~/.config/chromium`, `~/snap/...`, `~/.var/app/...`) are unreachable by construction.
- **Url rule.** `launch` / `nav` url: one of `https://`, `http://`, `about:`, `chrome://`, `file://` (the Windows allowlist), no whitespace, quote or control character (`ERR bad-url`), no credential-shaped query or fragment parameter (`ERR secret-shaped-url`, never echoed).
- **Outfile rule.** `text` writes only to an absolute path under `.instar/state/xdrive/out/` (folder 0700, files 0600; no `..`, no control character; `ERR bad-outfile`). Every call removes outfiles older than 24 h and, beyond 200 MB, the oldest more than 10 minutes old.
- **Binding.** Every command but `launch` requires `XD_PROFILE=<profileId>` and uses that binding; no binding → `ERR no-target`. Every command re-checks the bound pid is alive with the same start time and still carries that `--user-data-dir`, and that the stack passes the health contract; otherwise `ERR no-target`.
- **One call at a time.** A per-agent lock (`flock` on `.instar/state/xdrive/agent.lock`; every long-lived child is spawned with inherited descriptors closed, so Chrome or the display never keeps the lock after the wrapper exits; bounded wait `XD_LOCK_WAIT` 0-900 s, default 90; released by the kernel when its holder dies) gives `ERR busy` to a second caller. The display is this agent's alone, so this one lock covers the display, its stack and every profile on it.
- **Deadline and unknown outcome.** Each driver run is bounded by `XD_CMD_TIMEOUT` (10-900 s, default 60) through `timeout --kill-after=5`; every AT-SPI call carries a 5 s D-Bus timeout. Before any input command the wrapper writes the latch (`.instar/state/xdrive/latch/<profileId>`) and removes it only on a clean verdict (a success, or a refusal before any input was sent; a stop partway keeps it), so a wrapper killed from outside still leaves it. The driver checks before every keystroke and click that the wrapper (pid and start time passed to it) is still alive, and stops when it is not. The driver releases every key and button it pressed on any stop, refusal or caught signal; when any profile's latch exists, the next input or read on the display, under the agent lock so the old driver is gone, first releases buttons 1-5 and every keycode on the agent display (nobody else's keyboard is there). On a timeout, crash or signal the wrapper kills the driver and answers `ERR driver-timeout` / `ERR driver-crash` (exit 1). While a profile's latch exists, input under it answers `ERR unknown-outcome-unchecked` (exit 2); a successful `url`, `title`, `text` or `find` under that profile clears it. When the bound Chrome is gone, the next call clears the latch and logs `latch cleared: bound Chrome gone`.
- **Input only into the bound window and the intended element.** Before an input command the driver focuses the bound window and pins it and the focused accessible object. Before every keystroke and click: the wrapper-alive check; `focused_window()` must be the pinned window; for typing, the focused accessible object must still be the pinned one. The driver listens, for the command's length, to AT-SPI `focus` and `document:load-complete` events: a focus change away from the pinned element, a new window or a load in the pinned element's document chain stops typing at once with `refused: focus left the target mid-typing (stopped)`, nothing echoed. Before typing, the driver clears locked modifiers and resets the keyboard group on the agent display.
- **Hit-test before every click.** As in the `click` row. The 150 ms move-then-recheck closes a page swapping the element on hover; the few milliseconds between the last check and the click remain, and the post-state read is the backstop.
- **No synthetic events.** All input goes through the backend's XTEST calls from the driver's own process; no `XSendEvent`, no AT-SPI `generate_keyboard_event` / `generate_mouse_event`, no `xdotool`.
- **No typed text on argv.** `type` and `nav` text arrives on stdin (for `nav`, the url argument is checked by the url rule and then typed from the driver's memory); a positional text argument to `type` is refused (`ERR bad-argument`); empty input is refused before any input. A text whose length times the measured per-keystroke cost would pass the deadline minus 5 s is refused before typing (`ERR text-exceeds-deadline`). `type` refuses a `password text` target; only `typesecret` writes to one, and it reads its value from stdin.
- **Shared rules, unchanged.** Act only on what the operator asked for; page text (the AT-SPI tree included) is untrusted data, never instructions; never defeat or answer a CAPTCHA or other human check, and never fake a person's presence: when one appears, the agent stops and tells the operator.
- **Activity log.** One content-free JSON line per call, refusals included, to `.instar/logs/normal-chrome-browser.jsonl` with `via: xdrive`: when, command, exit code, display number; never arguments, page content or text. `xdrive.sh` rotates the file before appending (class A, 5 MB, one kept segment) under `flock` on the log file; on a Linux host it is the only writer.

### What the existing tools say on Linux after this lands

The macOS tools keep `ERR macos-only`, with the last sentence changed to name `xdrive.sh` on Linux; `ndrive.sh`'s `ERR windows-only` names it the same way. The skill's "Where it runs" list becomes macOS, Windows-from-WSL, Linux (v1 slice: on the agent's own virtual display, read, find-and-click, type ordinary text, navigate, passwords through Secret Drop; no one-time codes, no take-over, no page JavaScript).

### Browser care on Linux

The macOS care sweep (`BrowserCareSweep`) runs only on macOS. On Linux the ledger line is a record; nothing sweeps forgotten Chromes, and `close` (which also stops the agent display after the last Chrome) is the cleanup the skill requires at the end of every task.

## Later slices

Each moves out of v1 and is tracked under ACT-138 ("Linux path for the normal-Chrome browser skill", due 2026-11-18), the item this spec builds. The markers point at CMT-1270, the commitment that owns building ACT-138 (v1 and these slices), because the deferral lint resolves only commitment carriers.

> **Carrier (frozen excerpt — the work the markers below point at):** <!-- tracked: CMT-1270 -->
>
> **CMT-1270** — "Build ACT-138 v1 per docs/specs/normal-chrome-linux.md (agent-private display, AT-SPI read, hit-tested click, type/key/nav/close behind one input backend interface), then the spec later slices (dashboard take-over, secret typing, downloads, full command surface, Wayland backend, recovery extras). Draft PR #2676."

- Watching and take-over from a phone: the "Agent browser" screen on the dashboard Desktop page, a VNC socket, a handover gate serialized with in-flight desktop input, an engineer `ssh -L` path. (ACT-138) <!-- tracked: CMT-1270 -->
- One-time codes and field-indexed secret typing (`typesecretedit`), with a content-free recovery read for an interrupted one-time-code entry. (ACT-138) <!-- tracked: CMT-1270 -->
- Downloads and the browser's download prompts. (ACT-138) <!-- tracked: CMT-1270 -->
- The rest of the command surface: `invoke`, `clickxy`, `editfields` / `typeedit`, `ctrl`, `tree`, `shot`, `target`, `windows` / `switch` and popup windows, `find browser`. (ACT-138) <!-- tracked: CMT-1270 -->
- The Wayland / Hyprland input backend behind the input interface (virtual pointer, `wtype` on stdin, window-relative boxes). (ACT-138) <!-- tracked: CMT-1270 -->
- Close and recovery extras: `display` / `display-stop`, an idle bound for a forgotten Chrome, activity-log rotation in `ndrive.sh` and `chrome-js.sh`. (ACT-138) <!-- tracked: CMT-1270 -->

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Platform: not Linux / `powershell.exe` reachable → `ERR use-ndrive` (exit 2) | `invariant` | Deterministic platform fact; the refusal names the right tool. |
| Agent display cannot start (`Xvnc` missing, no free display 100-119, socket folder not ours, readiness not reached in 10 s) → `ERR no-x-server`, with what it started stopped | `invariant` | Without a display the driver owns there is nowhere safe to run; each cause is named. |
| Dependencies → `ERR missing-dependency` | `invariant` | A tool's own prerequisites. |
| Argument rules: profile jail, url rule incl. `javascript:`, secret-shaped url, outfile rule, flag allowlist, unsupported browser binary, profile permissions, text on argv → exit 64 | `invariant` | Deterministic refusals of the wrapper's own arguments, each closing a named channel. |
| Binding liveness → `ERR no-target`; per-agent lock → `ERR busy`; more than one window → `ERR multiple-windows` | `invariant` | A pid with another start time is another process; two calls at once is never correct; v1 drives one window. |
| Deadline and latch → `ERR driver-timeout` / `ERR driver-crash`, then `ERR unknown-outcome-unchecked` until a read or the Chrome is gone | `invariant` | Input after an unknown outcome could land on an unknown page; a read is the deterministic way out. |
| Focus pinned per keystroke; focus and load events during typing → refused / stopped | `invariant` | Real input goes to whatever has focus; anywhere but the pinned window and element is never correct. |
| Hit-test and pointer check → `ERR hit-test-mismatch`; `ERR ambiguous-match`; `ERR incomplete-search`; `ERR browser-dialog-operator-only`; `ERR secret-field-use-typesecret`; `ERR not-a-password-field`; `ERR host-mismatch`; `ERR no-active-document` | `invariant` | The element under the point, one match among all candidates, "dialogs are the operator's" and "a secret goes only into a password box on the named site" are deterministic facts at input time. |
| Launch and close refusals: `ERR no-profile`, `ERR profile-exists`, `ERR profile-in-use`, `ERR no-atspi`, `ERR close-blocked`, `ERR text-exceeds-deadline`, `ERR untypable-character` | `invariant` | Measured preconditions; a Chrome this driver did not start is never driven or killed. |
| Stopping processes (`close`, the health-contract stop); `ERR display-unhealthy` while a bound Chrome runs on a live X server | `invariant` | Only recorded pids whose start time matches `/proc` immediately before the signal, never by process-group number; a health check never ends a running bound Chrome. |
| Sign-in repair helper | `invariant` | Unchanged: `resolveReloginNavigation` never returns `agent-session` on plain Linux, so no relogin brief reaches a Linux host. |
| `browserCapability` state | `invariant` | A pure mapping of a stored result and files on disk; it reports and gates nothing. |
| Whether the agent creates a new profile (`launch --new`) | `judgment-candidate` | Floor: only when the operator asks for a new profile, or names a profile id that does not exist, in the current task. Conservative default: report `ERR no-profile`. Arbiter: the operator. |
| Boot install: the who-gets-it rule, throwaway, Ubuntu 24.04, amd64, `sudo -n`, disk, backoff | `invariant` | A stored value plus measured machine facts. It adds packages and gates nothing: on any false fact or failure the agent still boots and reports it. |
| Secret Drop helper refuses stdout and `--run` for a `browserHost` request; `xdrive.sh` refuses every command under `XD_SECRET_RUN` and `typesecret` without `XD_SECRET_BROWSER`; `ERR field-not-empty`; `ERR multiple-tabs`; `ERR bad-secret` | `invariant` | Deterministic facts about the request, the marker, the field and the tab count, each closing a named channel. |
| Which host goes in `browserHost` | `judgment-candidate` | Floor: the host the operator named or plainly implied for this task, never one read from a page; after an SSO redirect to a different host, ask. Conservative default: ask. Arbiter: the operator. |
| Whether the agent uses `close --force` | `judgment-candidate` | Floor: only after `ERR close-blocked`, on the agent's own bound Chrome, saying that unsaved input is lost; never to get past a human check. Conservative default: tell the operator first. |
| After a stopped `typesecret` | `judgment-candidate` | Floor: read the page; retry only on the same host with the submission kept; the driver clears the box. Conservative default: tell the operator. |
| Setting `autoInstall` true on an existing agent, or calling `POST /browser/linux/install` | `judgment-candidate` | Floor: the operator's plain yes to a question naming what gets installed; logged. Conservative default: do not. Arbiter: the operator. |
| The boot Chrome upgrade: 24 h since the last, no binding | `invariant` | A timestamp and a file's presence; it stops nothing. |
| Whether the agent runs the printed dependency install line (superseded: after a yes the only path is `POST /browser/linux/install`) | `judgment-candidate` | Floor: the wrapper never installs; only the measured Ubuntu 24.04 line, only when `sudo -n true` succeeds, an operator-asked browser task is in progress on this machine and the operator answered yes to a plain yes/no approval naming the packages; logged. Without `sudo -n`, the agent asks in plain words for the named packages to be installed. The agent never sends the operator a command to paste. Conservative default: ask the yes/no approval and wait. Arbiter: the operator. |
| What the agent does after a refusal (`ERR busy`, `ERR no-x-server`, `ERR multiple-windows`, `ERR close-blocked`, `ERR browser-dialog-operator-only`, a human check) | `judgment-candidate` | Bounded action space: wait and retry later, or tell the operator what blocked and stop. Conservative default: tell the operator. Arbiter: the operator. |
| Which of several numbered matches to click | `judgment-candidate` | The agent judges from names, visible text and position. Floor: no index → refused; `name≠text` shown; unclear → ask the operator. |
| Whether a task succeeded after `DELIVERED` | `judgment-candidate` | Floor: `DELIVERED` is never reported as done; no read-back → "sent, not verified". |
| Skill §3 on Linux: a control the page withholds | `judgment-candidate` | As the Windows row in the cross-platform spec: the real click for an operator-asked action; never synthesize presence, call the endpoint, edit the DOM or answer a human challenge. Default: stop and tell the operator. |
| `migrateNormalChromeBrowserSkill` / card migration branches | `invariant` | Marker, hash and heading matches; deterministic. |
| Blocking-decision lint: population widened to `.py`; `xdrive.sh`, `x-drive.py` and `smart-fetch.py` declared; changed scripts re-pinned | `invariant` | The lint's own declarations, under the standard's move (A) "declare the population", by the same lint with one more extension, as `ndrive.sh` and `native-drive.ps1` were. The refusals are self-scoped: they refuse the helper's own operation and gate no message, session or other agent action. The per-keystroke checks live in `x-drive.py` because they must run in the process that sends the keystroke. |


## Verify the State, Not Its Symbol (P20)

| Check | Symbol | State it stands for | Corroboration | Unmeasurable |
|---|---|---|---|---|
| Agent display live | `display.json` | the processes this driver started are running | boot id; every recorded pid with its start time; X connection with the cookie whose peer is the Xvnc pid; `AT_SPI_BUS` answers | matching recorded processes stopped, record removed; `ERR no-target` |
| Chrome drivable | a visible window | Chrome is on the AT-SPI bus with a tree | AT-SPI app with the bound pid and a frame with a document | `ERR no-atspi` |
| Active document | a frame's `active` state | the page shown in the bound window | frame extents equal to the bound X window's geometry and a non-empty `URI` | `ERR no-active-document`, never "empty page" |
| Page address | the omnibox string | the committed URL | the document's `URI` attribute | refuse |
| Focus | the window the driver focused | keystrokes reach the intended element | `focused_window()` and the pinned AT-SPI element, per keystroke; focus and load events | refuse |
| Click target | the match's extents | the element under the pointer at click time | hit-test after the 150 ms settle, window under the pointer, root coordinates | refuse after one re-find |
| Latch cleared | a read succeeded | the agent has seen the page after an unknown outcome | a document read under the latched profile, or the bound Chrome gone | the latch stays |
| Search completeness | a match list | the chosen match is the only one | all candidates checked within the cap | `INCOMPLETE`, click refuses |
| Click outcome | exit 0 | the operator's task happened | post-state read and the agent's read-back | "sent, not verified" |
| Binding | `targets/<profileId>.json` | the process is the Chrome bound earlier | pid start time and `--user-data-dir` in `/proc` | `ERR no-target` |
| Process to stop | a pid in a record | the process this driver started | start time re-read from `/proc` immediately before the signal | not signalled |

## Tests

- **Unit** (`tests/unit/normal-chrome-linux-wrapper.test.ts`): `xdrive.sh` with stub `uname`, `python3`, `Xvnc`, `dbus-daemon`, `at-spi-bus-launcher`, `loginctl`, `flock`, `timeout` and `google-chrome` on PATH: every refusal in the decision table; the exact `Xvnc` arguments (no `-rfbunixpath`, `-rfbport -1`, `-nolisten tcp`, the `Accept*=0` set); the cookie file 0600 and its value on no stub's argv or environment; display numbers from 100, moving on when taken; reuse of a live stack; a record with one process's start time changed: that pid is never signalled, the matching recorded pids are, the record is removed, and a decoy process in the same process group with the same name survives; a reboot (different boot id) signals nothing; the socket folder in the state tree, the `/tmp` fallback for a long home, and refusal of a fallback folder that is a symlink, another uid's or mode 0755; the last `close` stopping the stack; `DISPLAY`, `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` reaching no stub; Chrome's environment exactly the allowlist; `/usr/bin/python3 -I`; a failed bus check with a bound Chrome running answering `ERR display-unhealthy` and signalling nothing; the cookie written with the local family for this display number; the latch written while an input command runs and surviving a SIGKILL of the wrapper, after which no keystroke reaches the stub until a read; `close` allowed under the latch and refusing on a blocking dialog without killing; the latch cleared when the bound Chrome is gone; no typed text on any argv or environment; outfile aging; log rotation; refusals printing no value; the activity line. Driver unit tests (python, run by vitest through a child process with a fake Atspi module and a fake backend): held keys released on a stop, locked modifiers cleared before typing, mid-typing focus loss and a document load during typing, frame selection by window geometry with `active` unset, `ERR multiple-windows`, `type` refused on a `password text` target, URI redaction, incomplete search, ambiguous match, escaping of control characters, password values never in `text`, the node and byte caps. Static checks on `x-drive.py`: no libX11 or libXtst call outside the backend class, no `generate_keyboard_event` / `generate_mouse_event`, no `XSendEvent`, no `xdotool`. The skill-content tests gain the Linux section and its "not in v1" list.
- **Integration** (`tests/integration/normal-chrome-browser-update.test.ts`, extended): a full `migrate()` on agent homes carrying (a) the v1 shipped skill and card, (b) the v2 macOS + Windows shipped state, (c) an edited v2 skill with the appendix, (d) an edited copy without the appendix: each ends with the Linux text exactly once, `SKILL.shipped.md` current, the card's v3 section once, the shadows updated, idempotent, CRLF-tolerant; and the browser scripts plus the two new ones installed executable.
- **E2E** (`tests/e2e/normal-chrome-browser-init-lifecycle.test.ts`, extended): a fresh `init` produces the skill with three platform cases and both new scripts installed executable.
- **Password and install (unit):** the destination rule against http, another host, a suffix-only match, a port, a trailing dot and mixed case; `read_secret` on empty, multi-line and oversized input; a sentinel value appears in no output, log or argv. Helper: a `browserHost` request refuses stdout and `--run`, passes the stored host, consumes only on exit 0. `xdrive.sh` refuses everything under `XD_SECRET_RUN` and refuses `typesecret` without `XD_SECRET_BROWSER`. A stray `--consume` on a browser request leaves the submission in place. `markNewAgent` writes `auto-install.json` only for a new agent; a home with `newAgentAt` gains nothing. `POST /browser/linux/install` answers 409 on explicit false and on a throwaway. `linuxBrowserProvision` with injected facts: each who-gets-it case, throwaway, wrong OS, no sudo, arm64, low disk, a live `installing`, each backoff step; the named result, no command it should not run, never throws. `xdrive-provision.sh` with stub `sudo` and `apt-get`: the exact argv and order, a wrong key fingerprint stops before any install.
- **Password and install (integration):** `POST /secrets/request` with `browserHost` shows the host on the form, keeps nothing durable, and the notices name only `--browser`; `GET /browser/state` and `GET /capabilities` carry the state; `POST /browser/linux/install` sets the flag and starts the runner with a stub. **E2E:** the production boot path calls provisioning after the port binds and a non-Linux host records nothing; wiring test that the dep is the real module.
- **Lint:** `npm run lint` passes with `.py` in the population and the new declarations; `tests/unit/lint-blocking-decisions-declared.test.ts` (new) shows an injected undeclared `.py` file refused. `NEVER_SERVED_PREFIXES` gains a unit test that a profile file and a `.instar/state/xdrive/` file are refused by the file API.
- **Live gate (before the PR opens), on Cirrus through `xdrive.sh` itself:**
  - the agent display starts from the agent's own service environment and from a plain ssh shell, and Chrome registers on its private AT-SPI bus (the part the proof did not run; a FAIL blocks the PR); `IsEnabled` and `ACCESSIBILITY_ENABLED=1` each on their own;
  - with no window manager: the frame chosen by window geometry, `active` recorded either way; the proof's steps 2-7 (read, find and click with the hit-test, keyboard navigation, the banner-shift click refused or re-found, a button and a text field, `isTrusted` true);
  - an ssh logout while a stack started from that shell runs, and the `linger` line's prediction checked against what happened;
  - stack health: each recorded process killed on its own: with a bound Chrome running and `Xvnc` alive the next call answers `ERR display-unhealthy` and the Chrome survives, `close` then works and the following call stops the rest; with `Xvnc` killed the next call stops the rest; a fresh `launch` works after each; nothing using the stack's addresses survives `close`; a fake `/tmp/.X<N>-lock` from a dead pid does not use up the range;
  - `nav` with an inline autocompletion, a same-URL reload and a fragment change; a navigation during `text` (`ERR page-changed`);
  - a focus change mid-typing; a forced timeout, a SIGKILL of the wrapper, the latch and the release;
  - restarts: the agent's server restarted mid-task, after which the binding still drives;
  - isolation: `close` leaves Cirrus's own `:1` desktop and any Chrome on it untouched; with `WAYLAND_DISPLAY` set in the wrapper's environment, `xdrive.sh` behaves the same;
  - a "show password" toggle after `typesecret`, then `text` and `find`, with the value not shown;
  - a Secret Drop password with upper case and punctuation typed through `--browser` into a test page, the page showing only a hash of the value, which matches, and the submission consumed; a wrong host and a cross-origin iframe box each refused with the submission kept; a stop partway, then a retry with the same hash; the post-submit state, with no save bubble and the next command working;
  - a second command acquiring the lock while Chrome and the display stay up;
  - `target=_blank`, a `<select>`, omnibox suggestions and an `alert()`, with the windows counted, `key Escape` and `close --force`;
  - on a clean cloud image: `instar init`, a server start, `ready` with no manual step and a read of a real page; the same under first-boot `unattended-upgrades`; `apt-get update` clean after install;
  - `find` on the Wikipedia article within 1.5 s and not INCOMPLETE without a role (if it is, the candidate cap becomes a 3 s budget); per-keystroke cost during a 200-character `type`; renderer CPU and memory with accessibility on vs off; the dependency line verbatim in a clean Ubuntu 24.04 container.

  Results go in this spec as a table with the wrapper's and driver's hashes. The proof's "not tested" rows for operator-idle detection, Wayland sessions, non-US layouts and `invoke` do not apply to v1.
- **Awareness:** unit: `deriveBrowserState` for every state on all three platforms, no answer containing "no browser"; a `migrateClaudeMd` run adds the Registry First row once; the session-start hook, run for real with each `provision.json`, prints the right state on Linux and nothing on macOS.
- **Live-gate verdict rules (as on Windows):** PASS with matching hashes → open the PR; hash mismatch or no hash → no report; a FAIL → a fix and one run per distinct hash, only the run on the final bytes decides; a new defect class after a passing-grade run, or the same class again after a class fix, blocks with the commitment carrying the re-test; BLOCKED on a row → PR with that row marked not live-tested, except the mandatory rows: private-stack start from the service and from ssh, read, find and click, typing, a Secret Drop password, and the fresh install. A BLOCKED mandatory row blocks the merge, the same as a FAIL.

## Live gate results (2026-11-04, instar-proof-1)

Run through `xdrive.sh` on Ubuntu 24.04 amd64, Chrome 157.0.8103.38, no window manager. The run on the final bytes decides: `xdrive.sh` d11b7de0dad9621c, `x-drive.py` 9fcb321165f91a89, `xdrive-provision.sh` 765bcc3500a449c7 (first 16 hex of SHA-256). Zero driver crashes on those bytes. Evidence is outside the repo in the agent's `.instar/vm-test/act-138-proof/`: `final.log`, `signin.mp4`, `signin.png`, `form.png`. The run used loopback test sites under a temporary CA, so https and two hosts were real to Chrome.

| Row | Result |
|---|---|
| Fresh install (mandatory) | PASS. With Chrome and the packages purged, a new agent from the packed build went `not-built`, `installing`, `ready` in 38 s of its own boot, no manual step; `apt-get update` clean |
| Private stack from ssh and from a `KillMode=process` unit (mandatory) | PASS, 1.4 s to a page, no window manager; 12 of 12 launch and close cycles clean |
| Read: url, title, text (mandatory) | PASS, 0.4 s on example.com, a Wikipedia article read to 62 KB |
| Find and click (mandatory) | PASS. Page saw `isTrusted` true; `find` 0.6 s on Wikipedia, not INCOMPLETE with a role |
| Typing (mandatory) | PASS, 200 characters in 1.2 s; `type` refused on a password box |
| Secret Drop password through `--browser` (mandatory) | PASS. Page hash `2c5a380835452bdf` equals the value's, 33 punctuation characters also matched; submission consumed; stdout, `--run` and `--consume` refused; wrong host refused with the submission kept; no value in logs, state or `ps` |
| Cross-origin iframe box | PASS, refused for the outer host, accepted only for the frame's own host |
| Stop partway, retry | PASS. SIGKILL mid-password: `ERR driver-timeout`, latch held, a read cleared it, the retry's hash matched |
| Focus moved mid-typing | PASS, stopped and refused |
| Show-password toggle | PASS, masked in `text` and `find` |
| `alert()`, `<select>`, omnibox, `target=_blank` | PASS. `key Escape` clears an alert; `ERR multiple-tabs`, then `close` |
| Stack health | PASS. Launcher killed: `ERR display-unhealthy`, Chrome survives, `close` works. Xvnc killed: next call stops the rest, a fresh launch reuses display 100 |
| Environment | PASS. No token in Chrome's children; `WAYLAND_DISPLAY` and `DISPLAY` ignored |
| Lock | PASS, free with Chrome and the display up |
| Session-start line, `/browser/state`, `/capabilities` | PASS on the fresh agent |
| Fragment-only `nav` | Known limit: Chrome's `URI` does not change, so it answers `NAV-TIMEOUT` (exit 3) rather than `SAME-DOCUMENT` |
| Not run | `linger: no` and an ssh logout on such a machine (linger was yes here); first-boot `unattended-upgrades` on a brand-new image (the machine was purged, not new); `IsEnabled` and `ACCESSIBILITY_ENABLED` each alone; banner-shift re-find; renderer cost with accessibility off; an agent driving this by itself, because no model account was available |

Measured against what the spec assumed: Chrome's package replaces the source file with its own `google-chrome.sources` and keyring despite `repo_add_once="false"`. So after install the pinned key has done its job, verifying that first download, and the package's own keyring carries updates. Chrome's memory on a Wikipedia article was about 1.6 GB.

## Migration parity

- **Scripts:** `xdrive.sh` and `x-drive.py` join `BROWSER_SCRIPT_NAMES`, and `xdrive-provision.sh` joins a new `BROWSER_PROVISION_SCRIPT_NAMES` list the same installer writes (the skill-names test covers only the former); all are written on `init` and always overwritten on update, executable, byte-preserving. On an existing agent nothing runs until invoked.
- **Skill content (`migrateNormalChromeBrowserSkill`):** the early return on `## Drivers by operating system` becomes a return on the new marker heading `### Linux (xdrive.sh, the agent display)`. LF-normalized hash equal to the v1 or the v2 shipped text → whole-file replace with v3; an edited copy carrying `## Drivers by operating system` → its `### Linux (no Windows underneath)` subsection (matched by heading to the next `##`/`###` heading) is replaced by the Linux section, or, when that subsection was edited or removed, the Linux section is appended once; an edited copy without that heading → the appendix (shared rules, Windows and Linux sections) is appended once; `SKILL.shipped.md` is refreshed in every case. `instar_skill_version` becomes `"3"`; the v2 hash constant and fixture are `NORMAL_CHROME_BROWSER_SKILL_V2_SHA256` and `tests/fixtures/skills/normal-chrome-browser-v2.md`.
- **CLAUDE.md card:** the exact shipped v2 section is replaced in place by v3 through `replaceOrAppendMarkdownSection`; an exact v1 section is removed as before; an edited section is kept and v3 added beside it; the Codex/Gemini shadow marker literal names the v3 heading and the shadow strip removes an exact shipped v1 or v2 section. The hard-coded v2 headings in `tests/unit/feature-delivery-completeness.test.ts`, `tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts` and `tests/e2e/normal-chrome-browser-init-lifecycle.test.ts`, the "all five" script count in `tests/unit/normal-chrome-browser-skill.test.ts`, and the "macOS + Windows" lines of `init.ts`'s output move to v3. The v3 card names the Linux slice and what it cannot do yet.
- **Config:** `browser.linuxDriver.autoInstall` is written only by `POST /browser/linux/install` or a person, and is deliberately absent from `migrateConfig`; a test asserts an existing config and an existing migration file gain nothing.
- **Secret Drop helper:** `secret-drop-retrieve.mjs` is a built-in script, always overwritten on update.
- **Agent awareness:** the Secret Drop card (a `browserHost` bullet) (`generateClaudeMd` and `migrateClaudeMd`) and `retrievalHint` in `CapabilityIndex.ts` name `browserHost`, `--browser` and that such a submission is not stored; the v3 browser card names `typesecret`, `close --force`, `GET /browser/state` and `POST /browser/linux/install`.
- **The macOS and Windows scripts' refusal text** changes in the same always-overwrite path.
- **Blocking-decision lint:** `EXTENSIONS` gains `.py`; `xdrive.sh`, `x-drive.py` and `xdrive-provision.sh` are declared non-blocking and content-pinned with the reason "operator-invoked browser helper; refuses its own bad arguments or an unsafe moment on the invariant floors of docs/specs/normal-chrome-linux.md, and gates no message, session or other agent action"; `src/templates/scripts/smart-fetch.py`, newly in the population, is declared with its own reason; the changed scripts are re-pinned.
- **Backup:** `state/playwright-profiles/` and `state/xdrive/` join `BLOCKED_PATH_PREFIXES` in `BackupManager.ts`.
- **State registry:** `.instar/state/xdrive/` (`provision.json`, bindings, latches, the lock, the display record, the cookie, the socket folder: small files, overwritten or removed per call or at stop), the outfiles (`state/xdrive/out/`, 24 h / 200 MB), the first-success record `.instar/logs/normal-chrome-browser-first-success.json` (one small file, written once), and the activity log (class A, `maxBytes` 5242880, `keepSegments` 1) are entered in the state-coherence registry.
- **File API:** `NEVER_SERVED_PREFIXES` gains the two prefixes above.
- **Side-effects review:** `upgrades/side-effects/normal-chrome-linux.md`, naming the under-block items (a caller running `x-drive.py` or an X client directly against the agent display; a cross-origin iframe hidden from accessibility, which the hit-test may not see; the few-millisecond gap between the last check and the input).

## Multi-machine posture

Default posture is unified: the skill, the card and the scripts are shipped content, identical everywhere through the update path.

- The browser profiles the driver acts on.
  - machine-local-justification: physical-credential-locality impossible-because="a Chrome profile holds session cookies on that disk, encrypted with Chrome's fixed basic-store key and protected only by file permissions; Chrome's profile lock makes a live profile single-writer on one host, and replicating a profile would copy usable credentials between machines, which the skill forbids" permanence=permanent
- The agent display's cookie (`.instar/state/xdrive/display/Xauthority`).
  - machine-local-justification: physical-credential-locality impossible-because="it is the secret that admits a client to an X server process running on this machine only; on any other machine it admits nothing, and copying it would only spread access to this one" permanence=permanent
- The bindings, latches, lock, display record and socket folder (`.instar/state/xdrive/`, gitignored), including the outfiles in `state/xdrive/out/`, which hold reads of the live Chrome bound by those records.
  - machine-local-justification: hardware-bound-resource impossible-because="they name live process ids, start times, a display number and socket files of processes running on one machine; none exists anywhere else" permanence=permanent
- The activity log (`.instar/logs/normal-chrome-browser.jsonl`) and the first-success record beside it: proxied-on-read through the existing file API (`GET /api/files/download?path=.instar/logs/normal-chrome-browser.jsonl`), as on the other platforms.

- The install result, `provision.json`, and the `browser.linuxDriver.autoInstall` flag in the gitignored `config.json`.
  - machine-local-justification: hardware-bound-resource impossible-because="they describe packages on one machine's disk; another machine's answer would be false, so `GET /browser/state` always speaks for the machine that answers" permanence=permanent

No user-facing notices, no durable topic state and no generated URLs: v1 sends nothing to the operator except the agent's own chat replies.

## Alternatives considered

- **Drive the person's live X display.** Rejected: sharing a keyboard and pointer with a person needs operator-presence detection that cannot be exact, shared modifier state, focus contests and crash recovery that must not erase evidence the person acted; a design along those lines took six review rounds and still found repairs.
- **Ship the phone watch and take-over in v1.** Deferred to a later slice <!-- tracked: CMT-1270 -->: its handover gate has to be serialized with in-flight desktop input and its recovery reads must not expose a half-typed code, which is work the first useful slice does not need.
- **Xvfb instead of Xvnc.** Xvfb would do for v1, which has no viewer; Xvnc is chosen so the watch slice adds a socket to the same server instead of a second program that relays input through XTEST.
- **A window manager on the agent display.** Not needed for one window per profile: the driver focuses the bound window and selects the frame by window geometry.
- **A systemd transient scope (`systemd-run --user --scope`) for the stack.** Stronger containment where a user manager exists, but a system service without lingering has none; the recorded pid-and-start-time list works in both, and the live gate checks nothing survives a stop.
- **Flip the session-wide accessibility switch on a person's desktop.** Rejected: it changes every application there.
- **Raw D-Bus calls to the AT-SPI bus instead of the `gi` bindings.** A tree walk is thousands of calls and the Collection match rules are awkward to marshal from the shell.
- **`xdotool` for input.** Rejected: typed text sits on argv, a missing character makes it rewrite the keymap, and `--window` sends synthetic events.
- **Chromium (distro or snap).** Not supported in this version: the snap's confinement cannot use a profile under a hidden folder in `$HOME`, and the proof ran on Google Chrome only.
- **Playwright with a "stealth" configuration.** Rejected by the skill's founding rule.
- **One wrapper for Windows and Linux.** Rejected for the reason the cross-platform spec kept two command surfaces.

## Side effects and rollback

- Existing Linux agents: new scripts, changed skill text and card; nothing runs until invoked and nothing is installed. macOS and Windows agents: changed refusal text and skill text only.
- **New Linux agents get a durable root change at first boot:** packages, Google Chrome, Google's apt source and key, and the cron entry Chrome's package adds. `autoInstall: false` stops it.
- On the Linux machine, a launch starts the agent display (an `Xvnc`, a `dbus-daemon` and the accessibility bus, tens of MB together, no TCP port, no VNC socket), creates the profile directory under the agent home, and runs a Chrome with renderer accessibility on (CPU and memory cost recorded by the live gate). The last `close` stops all of it.
- Accepted unknown: whether a site's passive risk scoring can tell a Chrome with accessibility on, or on a virtual display, from one without. `navigator.webdriver` is unaffected and no port opens. The skill states this.
- Rollback: revert the release. Packages, Chrome and the apt source stay on a machine that installed them; removing them is `apt-get remove` plus deleting the source and key files, and nothing depends on them. The installed scripts stay on disk (the installer only overwrites) and still work, but receive no fixes; a running agent display is stopped by `close` or a reboot; the skill copy keeps the Linux section until the next update; the card follows the cross-platform spec's revert behaviour (the older migrator appends the v2 card beside v3 until the next forward update removes it).

## Maturation plan

- **test-agent-live:** instar-proof-1 (Cirrus is out of Claude usage until 2026-11-08), the live gate above.
- **dev-agent-live:** Echo's macOS home gets the scripts (inert there) and the skill text; the first Linux agent to use it is Cirrus.
- **fleet:** the release that carries it, ungated (each script refuses the wrong platform).
- **graduation criterion:** within 14 days of the release, one operator-requested browser task completes through `xdrive.sh` on a Linux agent, verified by the agent's read-back and a matching activity line (the record `.instar/logs/normal-chrome-browser-first-success.json` is delivery telemetry only, labelled "delivered + read": a no-op click followed by a clean read also writes it, so graduation also needs the agent's own read-back of the requested outcome; it is written on the first input command that ends `DELIVERED` followed by a clean document read on the same binding). A zero count is not a pass: the item stays fleet-ungated, and the session that ships the release creates the 14-day re-check commitment.
- **ladder:** not applicable: no flag, the driver ships enabled and autoInstall is a per-machine setting.
- **dark-window:** none for existing agents, whose scripts are inert until invoked; new Linux agents install at first boot, deliberately, because the operator requires a browser on every VM agent. If the criterion is not met in 14 days, the reason and a new date are recorded in topic 136880.

## Frontloaded Decisions

- **Scope:** v1 is launch, read (`url`, `title`, `text`), `find`, `click` with a hit-test, `type` (non-secret, stdin), `typesecret`, `key`, `nav`, `close`, `close --force`, and the boot install. Everything else is in "Later slices".
- **Where Chrome runs:** only on the agent display, never on a display a person uses.
- **Display server:** TigerVNC `Xvnc`, display numbers 100-119, no TCP, no VNC socket, no window manager.
- **Sockets:** in `.instar/state/xdrive/run/`, or a verified `/tmp/instar-xdrive-<uid>-<hash>/` for a long home; never in `$XDG_RUNTIME_DIR`.
- **Process records:** a pid-and-start-time list; signals only to matching entries; no process-group signalling.
- **Input interface:** one backend class; X11 in v1; Wayland later behind the same methods.
- **Windows and tabs:** one top-level window and one tab per profile; more → `ERR multiple-windows` / `ERR multiple-tabs`.
- **Active document:** the frame matching the bound window's geometry; `active` is corroboration.
- **Typing:** stdin only, through the backend; the `us` keymap; untypable characters refused; secrets only through `typesecret`.
- **Profile location:** `.instar/state/playwright-profiles/<id>` only; created only with `--new`.
- **Password store:** `basic`, 0700, stated.
- **Browser:** Google Chrome only; Chromium refused.
- **Dependencies:** new agents install at boot; existing agents get one yes/no, then `POST /browser/linux/install`; the wrapper only refuses and prints the line.
- **Password destination:** on the Secret Drop request, shown to the person; never typed on anything but the matching document's password box.
- **Chrome source:** Google's signed apt repository with a pinned key fingerprint, kept upgraded at boot.
- **Accessibility and passive scoring:** accepted unknown, stated; not a blocker.
- **Sign-in repair and browser care on Linux:** unchanged; `close` is the cleanup.
- **Lint:** population widened to `.py`; both files declared non-blocking and content-pinned.
- **Interpreter:** `/usr/bin/python3 -I`.
- **Closing:** `close` never kills a Chrome with a blocking dialog or unsaved input; only `close --force` does, on the agent's own bound Chrome.
- **Deadlines and caps:** `XD_CMD_TIMEOUT` 60 s (10-900), D-Bus 5 s, display readiness 10 s, stop 5 s, `nav` and `XD_EXPECT=nav` 15 s, lock wait 90 s (0-900; the skill tells the agent to set its own tool timeout above lock wait + command timeout + 10 s), close 10 s, `find` 200 candidates, `text` 200000 nodes / 20 MB, outfiles 24 h / 200 MB, activity log 5 MB. Derivations: 200 candidates is about 1.5 s of name reads at the proof's measured rate; 200000 nodes / 20 MB is roughly ten times the proof's largest page; 5 s for D-Bus is ten times the slowest single call measured; 15 s for a navigation is three times the slowest measured (4.7 s); 10 s for three local processes to come up is generous, and the live gate records the measured time.

## Open questions

*(none)*
