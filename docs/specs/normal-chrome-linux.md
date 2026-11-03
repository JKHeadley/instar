---
title: "Normal-Chrome browser skill: the Linux driver (X11 input + AT-SPI reading)"
slug: "normal-chrome-linux"
author: "echo"
parent-principle: "Self-Unblock Before Escalating"
eli16-overview: "normal-chrome-linux.eli16.md"
lessons-engaged: >
  P1 Structure > Willpower (every Linux safety rule is enforced in the wrapper xdrive.sh, the only Instar
  entry point: platform and session-type check, profile jail, url rule, flag allowlist, per-agent binding,
  active-window check before every input, AT-SPI hit-test before every click, operator-idle gate, no
  credential on argv); P3 Migration Parity (the two new scripts ride the existing always-overwrite browser
  script installer; the skill's "Linux: not built" text and the CLAUDE.md card sentence are shipped content
  that existing agents only get through a hash-gated PostUpdateMigrator step, specified below); P4 Testing
  Integrity (three tiers; the wrapper's refusals are driven with stub xdotool and python3 on PATH; the live
  tier runs on Cirrus's XFCE/TigerVNC display before the PR opens); P5 Agent Awareness (the CLAUDE.md card and
  the skill name all three platforms and the Wayland refusal); P11 / P12 A Wall Is a Hypothesis / Never a
  False Blocker (the "Linux: not built" wall was tested on a real Linux desktop on 2026-11-03 and holds only
  for Wayland sessions); P14 Distrust Temporary Success (a click is reported by re-reading the document URI,
  never by the click's exit code; the proof's first link click "succeeded" and changed nothing); P19 No
  Unbounded Loops (every wait in the driver has a wall-time bound); P20 Verify the State, Not Its Symbol (the
  omnibox string is a symbol, the document's URI attribute is the state; a link's extents are a symbol, the
  hit-test at the click point is the state); P21 Multi-machine (line-leading markers below); the operator's
  rule of 2026-10-13 that Instar runs on at least Mac and Linux, which the macOS + Windows spec answered by
  naming this item (ACT-138); L9 ELI16 companion.
---

# Normal-Chrome browser skill: the Linux driver (X11 input + AT-SPI reading)

## Glossary

- **The skill:** `/normal-chrome-browser`, the built-in skill specified by `docs/specs/normal-chrome-builtin-skill.md` (macOS) and `docs/specs/normal-chrome-cross-platform.md` (macOS + Windows). This spec is the Linux twin of the second.
- **X11 / Xorg:** the classic Linux display system. Programs (and `xdotool`) can ask the X server to inject keyboard and mouse input through the XTEST extension; to the browser, that input arrives exactly like a physical keyboard's.
- **Wayland:** the newer Linux display system (GNOME and KDE default on many distributions). It deliberately does not let one program inject input into another's window or read global screen coordinates.
- **AT-SPI:** the Linux accessibility bus (the thing screen readers use). Chrome publishes its page as a tree of named, role-tagged objects with on-screen rectangles when accessibility is switched on.
- **Cirrus:** the operator's paired Instar test agent on a Hetzner Ubuntu 24.04 VM, with a TigerVNC user service (`vnc-display1`) running an XFCE desktop on `DISPLAY=:1`. Used for the proof below.
- **xdrive.sh / x-drive.py:** the names this spec proposes for the Linux wrapper (the Instar entry point, bash) and the driver (python3, one command per invocation). They mirror `ndrive.sh` / `native-drive.ps1`.

## Problem statement

The skill's shipped text says Linux "with no Windows underneath" is not built: `chrome-launch.sh`, `chrome-js.sh`, `chrome-mainworld.sh`, `chrome-close.sh`, `chrome-renew.sh` and `chrome-unsaved.sh` stop with `ERR macos-only: the normal-Chrome method uses macOS Apple Events; it does not run on Linux`, and `ndrive.sh` stops with `ERR windows-only: ndrive.sh runs native-drive.ps1 through powershell.exe from WSL ...`. An agent on a Linux machine (a cloud VM such as Cirrus, a Linux laptop) therefore cannot do any task that needs a normal, signed-in Chrome (sign-in, billing, settings and usage pages that refuse or behave differently for an automated browser), and the skill tells it to say so and stop. The operator's rule is that Instar runs on at least Mac and Linux; ACT-138 ("Linux path for the normal-Chrome browser skill", due 2026-11-18) is the recorded item for closing this.

The earlier direction (`.instar/vm-test/README.md`) named the method: a normal Chrome launched in the desktop session; input via `xdotool` (real X events); page reading via the AT-SPI tree (Chrome started with `--force-renderer-accessibility`); no CDP or remote-debugging port. This spec measures that method on a real Linux desktop and turns it into a driver design.

## The measured proof (Cirrus, 2026-11-03, 22:23-22:31 UTC)

Host: Cirrus, Ubuntu 24.04, session type `XDG_SESSION_TYPE=x11`, XFCE on TigerVNC `DISPLAY=:1` (1600x1000), Google Chrome 156.0.8078.79, xdotool 3.20160805.1, python3-gi 3.48.2. Throwaway profile `~/.config/chrome-act138-test`, public pages only (example.com, iana.org, en.wikipedia.org, one `data:` page I wrote), no sign-in. The Chrome I started was killed and its profile deleted at the end; no other process or service was touched. The proof helpers (`atspi-probe.py`: `apps`, `tab`, `text`, `find`, `at`, `tree`; `gclick.sh`: find, hit-test, active-window check, click) were copied to `/tmp` and removed afterwards.

### Step 0: prerequisites (one snag)

`python3-gi` was installed but the AT-SPI typelib was not: `gir1.2-atspi-2.0` and `python3-pyatspi` were missing. The `instar` user has passwordless sudo on Cirrus, so `sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y gir1.2-atspi-2.0 python3-pyatspi` installed them (4.2 s). The desktop's session bus was not in the ssh shell's environment; it was read from the XFCE session process: `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-7VPaByoIqu,...` (from `/proc/<xfce4-session pid>/environ`); the root window carries `AT_SPI_BUS(STRING) = "unix:path=/run/user/1000/at-spi/bus_1,..."`. `org.a11y.Status IsEnabled` and `ScreenReaderEnabled` were both `false`.

### Step 1: launch, and the accessibility switch (one snag)

```
google-chrome --user-data-dir=$HOME/.config/chrome-act138-test --password-store=basic --no-first-run \
  --no-default-browser-check --force-renderer-accessibility --new-window https://example.com/
```

The window appeared after 1.07 s (`Example Domain - Google Chrome`), but Chrome did **not** register on the AT-SPI bus (`apps` listed xfce4-session, xfwm4, Thunar, ... and no Chrome). `--force-renderer-accessibility` builds the page tree, but the browser process only connects to AT-SPI when it thinks assistive technology is on. Relaunching with **`ACCESSIBILITY_ENABLED=1`** in Chrome's own environment fixed it without changing any session-wide setting: Chrome registered after **0.47 s** (`16 'Google Chrome' 55792`).

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

`invoke` through the AT-SPI Action interface (`do_action`); typing a value from stdin; the operator-idle refusal with a real person at the VNC viewer; a Wayland session; Chromium (snap or distro package); a non-US keyboard layout. Each is a row in the live test plan below.

## Proposed design

### What the Linux driver can and cannot do

Like the Windows driver, and unlike the macOS tools: it **reads** through the accessibility tree (names, roles, rectangles, text, the document URI and title, focus and states) and **acts** through real OS input (mouse, keyboard). Real input carries user activation (an OAuth popup opens, a "a person clicked" check passes). It has **no page-world JavaScript**: there is no Linux equivalent of macOS's "Allow JavaScript from Apple Events", so `chrome-js.sh` / `chrome-mainworld.sh` (read a page's own variables, call its functions, find out why a control refuses) have no Linux twin. When an operator task needs page JavaScript, the agent says so plainly.

Other JavaScript channels were weighed and not chosen:
- **A Chrome extension with native messaging** would give page JavaScript, but branded Chrome no longer honours `--load-extension` (removed for branded builds from Chrome 137; to be re-checked on 156), so it needs a Web Store listing or an enterprise policy file under `/etc/opt/chrome/policies` (root); it is visible to pages that probe for extensions; it adds an install and update surface per machine and per profile; and it is a second, privileged control channel into a signed-in profile. Not worth it for the reading the tree already gives.
- **`javascript:` typed into the omnibox** does run in the page, but it is a URL the url rule forbids everywhere, it lands in omnibox history and suggestions, and a non-undefined result replaces the page. Rejected.
- **CDP / `--remote-debugging-port` / WebDriver:** forbidden by the shared rules.

### Command surface (mirrors `native-drive.ps1`)

All through `.instar/scripts/browser/xdrive.sh <cmd> [args]`; the wrapper calls `x-drive.py` (python3 + `gi.repository.Atspi` + `xdotool`), one command per invocation:

| Command | Linux mechanism |
|---|---|
| `launch <userDataDir> <url>` | `ACCESSIBILITY_ENABLED=1 google-chrome --user-data-dir=<dir> --password-store=basic --no-first-run --no-default-browser-check --force-renderer-accessibility --new-window <url>`, detached with `setsid`; binds the browser pid (the process whose `/proc/<pid>/cmdline` carries that `--user-data-dir` and no `--type=`), its X window (`xdotool search --pid`) and its AT-SPI app (matched by pid). Refused if Chrome already runs on that profile: use `attach`. Records the launch in the existing browser ledger (`chrome-ledger.sh`). |
| `attach <userDataDir>` | Binds an already-running Chrome on that profile; refuses (`ERR no-atspi`) if it is not on the AT-SPI bus, with the reason (launched without `ACCESSIBILITY_ENABLED=1`). |
| `target` / `canfocus` / `focus` | Print the binding (profile, pid, window id, active or not) / read-only "may input be sent now" (exit 2 while the operator is active) / `xdotool windowactivate --sync` on the bound window, then verified. |
| `nav <url>` / `url` / `title` | Ctrl+L, type, Enter / the active document's `URI` attribute (full URL) plus the omnibox string / the document title. |
| `text <outfile>` / `tree <outfile>` | Visible text of the active document, embedded objects expanded / the tree (role, name, rect, states) as JSON, UTF-8 without a BOM. |
| `find <name> [role] [browser]` | Showing elements of the active document whose name contains the text (Collection `get_matches`), with centre and rect; `browser` searches Chrome's own UI instead. |
| `click <name> [role] [browser]` | `find`, refuse unless exactly the chosen match is showing and inside the bound window, hit-test the centre (`get_accessible_at_point`, deepest child, the match or its descendant must be there), check the active window is the bound one, then `xdotool mousemove --sync x y click 1`. |
| `invoke <name> [role]` | AT-SPI `Action.do_action` on the match, no OS input; `canfocus` still runs first. Its user-activation behaviour is measured in the live test before the skill describes it. |
| `clickxy <x> <y>` | Raw click, refused unless the point is inside the bound window and the window is active; prints the hit-test chain so the caller sees what it hit. |
| `editfields` / `typeedit <index> <text>` / `typesecretedit <index>` | Entries and combo boxes of the active document top to bottom / focus field N (`Component.grab_focus`, verified by the `focused` state), select all, type / the same with ONE line from stdin. |
| `type <text>` / `typesecret` / `key <name>` / `ctrl <char>` | Raw input to the focused element of the bound window. `typesecret` reads ONE line from stdin. |
| `shot <outfile>` | `import -window <bound window id>`: that window only. |
| `close` | Closes the bound Chrome (Ctrl+Shift+W on each window, then SIGTERM to the bound pid after a bounded wait); ledger updated. |

### Rules the wrapper enforces (the shared rules, made Linux-specific)

- **Platform and session.** `uname -s` must be `Linux` and `powershell.exe` must not be reachable (otherwise `ndrive.sh` is the right tool: `ERR use-ndrive`). The session must be X11: if `WAYLAND_DISPLAY` is set, or `loginctl show-session` reports `Type=wayland` for the session that owns `DISPLAY`, the wrapper refuses with `ERR wayland-unsupported` and names the two ways out (log in to an "on Xorg" session, or use a virtual X display). No display → `ERR no-display`.
- **Finding the desktop.** An Instar agent is often started outside the desktop (systemd user unit, tmux, ssh), as the proof's ssh shell was. The wrapper takes `DISPLAY`, `XAUTHORITY` and `DBUS_SESSION_BUS_ADDRESS` from its own environment when they reach a live X server and a bus that answers `org.a11y.Bus`; otherwise from the environment of a desktop-session process (`xfce4-session`, `gnome-session-binary`, `plasmashell`, `mate-session`, `cinnamon-session`) owned by the same uid. It never connects to another user's display. Unresolvable → `ERR no-desktop-session`.
- **Dependencies.** `xdotool`, `python3`, `gi` with the `Atspi 2.0` typelib, `libXss.so.1`, and `import` (only for `shot`). A missing one → `ERR missing-dependency: <package>` with the distro's install line (`sudo apt-get install -y gir1.2-atspi-2.0` on Debian/Ubuntu). The wrapper never installs anything and never calls sudo.
- **Accessibility switch, scoped.** `ACCESSIBILITY_ENABLED=1` is set only in Chrome's environment. The wrapper never flips the session-wide `org.a11y.Status IsEnabled` or the GNOME `toolkit-accessibility` key (that would make every application on the operator's desktop publish its tree).
- **Flags.** The launcher adds exactly the flags above. Extra flags only through `XD_CHROME_FLAGS` with the Windows allowlist (`--disable-extensions`, `--start-maximized`, `--new-window`, `--window-size=W,H`, `--window-position=X,Y`, `--lang=xx`); anything else, in any spelling, is refused. `--force-renderer-accessibility` is an accessibility switch, not an automation flag: it does not set `navigator.webdriver` or open a port.
- **Profile jail.** Same filesystem posture as macOS: a profile is a directory inside this agent's home (`.instar/state/playwright-profiles/<id>` or an absolute path under the agent home), never `~/.config/google-chrome*`, `~/.config/chromium`, `~/snap/chromium/...`, `~/.var/app/...`, never with `..`, `~`, a quote or a control character (`ERR profile-reserved-folder` / `ERR profile-outside-agent-home` / `ERR bad-profile-path`).
- **Url rule.** `launch` / `nav` url must carry a scheme, no whitespace or quote, never `javascript:` (`ERR bad-url`), and no credential-shaped query parameter (`ERR secret-shaped-url`), as on the other platforms.
- **Binding and one call at a time.** The binding file is `.instar/state/xdrive/target.json` (profile, pid, pid start time from `/proc/<pid>/stat`, window id); every command re-checks that the pid is alive with the same start time and still owns the window. A per-agent lock directory (`.instar/state/xdrive/lock.d`, bounded wait `XD_LOCK_WAIT` 0-900 s, default 60) gives `ERR busy` to a second caller; a dead owner's lock is reclaimed.
- **Input only into the bound window, only when the operator is idle.** Before every input command: the active window (`xdotool getactivewindow`) must belong to the bound pid; the session's X idle time must be at least `XD_OPERATOR_IDLE_MS` (default 30000) measured since the last input that was not the driver's own (own-input tick file beside the binding); otherwise `refused: operator active` (exit 2). `focus` (taking the foreground) is allowed only under the same idle rule. The unattended-machine override is the same `normalChromeBrowser.unattendedMachine` record, procedure and 30-day validity as Windows; the wrapper reads the same key.
- **Hit-test before every click.** `click` and `clickxy` print what is under the point; `click` refuses (`ERR hit-test-mismatch`) when the match is not there, after one re-find. This is the rule the proof's Step 5 earned.
- **No synthetic events.** Input goes through XTEST (`xdotool` without `--window`). No `XSendEvent`, no AT-SPI `generate_keyboard_event` / `generate_mouse_event` into the page, no synthetic focus or hover.
- **Secrets never on argv.** `xdotool type <text>` puts the text in `/proc/<pid>/cmdline`, readable by every process of the same user. `typesecret*` therefore never calls `xdotool type` with the value: the driver types the stdin line itself through `libXtst` (`XTestFakeKeyEvent`, via ctypes, keysym lookup on the current keymap) and prints neither the value nor its length. Characters with no keycode on the current layout are refused (`ERR untypable-character`, no index or count printed) rather than remapped.
- **Page text is untrusted.** Unchanged shared rule; the AT-SPI tree is page text.
- **Activity log.** One JSON line per call, refusals included, to `.instar/logs/normal-chrome-browser.jsonl` with `via: xdrive`.

### What the existing tools say on Linux after this lands

The macOS tools keep `ERR macos-only`, with the message's last sentence changed to name `xdrive.sh` on Linux. `ndrive.sh`'s `ERR windows-only` names `xdrive.sh` the same way. The skill's three-case "Where it runs" list becomes: macOS, Windows-from-WSL, Linux on X11 (with the Wayland refusal stated).

### Headless servers and virtual displays

The driver needs a desktop session: an X server, a session D-Bus, and the AT-SPI bus launcher. A cloud VM without a desktop has none of these. Cirrus's arrangement (a TigerVNC user service running a full XFCE session on `:1`) is the proven one: the operator can watch and take over through a VNC viewer, and the AT-SPI bus is started by the session. A bare `Xvfb` with no session is not proven (no `at-spi-bus-launcher`, no session bus); the skill names the TigerVNC + desktop arrangement as the setup, and the wrapper's `ERR no-desktop-session` says what is missing. The driver never starts a display, a desktop or a bus itself.

## Decision points touched

- The skill's platform cases and its "honest capability note" (Linux joins Windows on the real-input side; no page JavaScript).
- The CLAUDE.md card's sentence "Linux with no Windows underneath is not built (ACT-138)".
- The script list `BROWSER_SCRIPT_NAMES` in `src/commands/init.ts` gains `xdrive.sh` and `x-drive.py`.
- `SubscriptionReloginHelper.ts` names the Windows section by platform; it gains the Linux case so a relogin brief on Linux points at `xdrive.sh`.

## Verify the State, Not Its Symbol (P20)

- A click's exit 0 is a symbol; the new document's `URI` attribute read afterwards is the state (Step 5 is the measured case).
- The omnibox string is a symbol (scheme hidden, editable while focused); the document `URI` is the state, and the url rule checks the origin from it.
- A match's extents are a symbol (layout shifts); the hit-test at the click point is the state.
- AT-SPI registration is the state for "this Chrome is drivable"; a visible window is not (Step 1).

## Tests

- **Unit** (`tests/unit/normal-chrome-linux-wrapper.test.ts`): `xdrive.sh` with stub `uname`, `xdotool`, `python3`, `loginctl` and `google-chrome` on PATH: every refusal (`ERR use-ndrive`, `ERR wayland-unsupported` for both detection routes, `ERR no-display`, `ERR no-desktop-session`, `ERR missing-dependency`, the profile jail cases, the url rule incl. `javascript:` and `code=`, the flag allowlist in `--flag` / `-flag` / `/flag` spellings, `ERR busy` and dead-lock reclaim, `refused: operator active`), that the launched command line carries exactly the listed flags and `ACCESSIBILITY_ENABLED=1` only in Chrome's environment, that no input command passes `--window`, that `typesecret*` never puts the value on any stub's argv and prints no value or length, and the activity line for success and refusal. Static checks on `x-drive.py`: no `generate_keyboard_event` / `generate_mouse_event`, no `XSendEvent`, input commands call the active-window check before the input call. The skill-content tests gain the Linux section, the Wayland statement and the capability note; the migrator tests below.
- **Integration** (`tests/integration/normal-chrome-browser-update.test.ts`, extended): a full `migrate()` on an agent home carrying the macOS + Windows shipped state ends with the Linux section in the skill (replace / append-to-edited / idempotent / CRLF), the new card sentence once, and the existing browser scripts plus the two new ones installed executable.
- **E2E** (`tests/e2e/normal-chrome-browser-init-lifecycle.test.ts`, extended): a fresh `init` produces the skill with three platform cases and both new scripts.
- **Live (gate before the PR opens):** on Cirrus, the proof's eight steps re-run through `xdrive.sh` itself, plus: `invoke` on a button (and whether the page sees user activation, via the `data:` probe), `typesecretedit` into a `data:` page's password field (the page shows only a match/no-match flag), the operator-idle refusal with input from the VNC viewer, `close`, and the ledger line. A second host for the Wayland refusal (a GNOME Wayland session) and one Chromium build. Results go in this spec as a table with the wrapper's hash.

## Migration parity

- **Scripts:** `xdrive.sh` and `x-drive.py` are added to the browser script list; the existing installer writes them on `init` and always overwrites them on update, executable, byte-preserving. Nothing runs until an agent invokes one.
- **Skill content:** the shipped full text changes (Linux section, three-case list, capability note). A copy byte-identical (LF-normalized) to the macOS + Windows shipped version is replaced whole (a new hash constant pinned by a fixture, as the previous step did); an edited copy that carries the previous appendix gets its "### Linux (no Windows underneath)" subsection replaced in place by the Linux section, idempotent by a new marker; an edited copy without an appendix gets the appendix; `SKILL.shipped.md` is refreshed in every case.
- **CLAUDE.md card:** the exact shipped macOS + Windows section is replaced in place (the existing `replaceOrAppendMarkdownSection` path), an edited one is kept and the new one added beside it, the shadows likewise; the heading names macOS, Windows and Linux.
- **The macOS and Windows scripts' refusal text** changes in the same always-overwrite path.

## Multi-machine posture

Default posture is unified: the skill, the card and the scripts are shipped content, identical everywhere through the update path.

- The browser profiles the driver acts on.
  - machine-local-justification: physical-credential-locality impossible-because="a signed-in Chrome profile's cookies are encrypted with that Linux user's keyring or the basic store on that disk; a copied profile is not a signed-in profile" permanence=permanent
- The binding file, own-input tick, lock directory and the resolved desktop environment (`.instar/state/xdrive/`, gitignored).
  - machine-local-justification: hardware-bound-resource impossible-because="they name a live process id, an X window id and a display of one machine" permanence=permanent
- The unattended-machine record: per machine, as on Windows (same justification as the cross-platform spec).
- The activity log: proxied-on-read through the existing file API, as on the other platforms.

## Alternatives considered

- **Flip the session-wide accessibility switch** (`org.a11y.Status IsEnabled=true` or the GNOME key) instead of `ACCESSIBILITY_ENABLED=1`. Rejected: it changes every application on the operator's desktop; the per-process variable was proven sufficient.
- **Raw D-Bus calls (`gdbus`/`busctl`) to the AT-SPI bus instead of the `gi` bindings**, to avoid the `gir1.2-atspi-2.0` dependency. Possible (the session bus answered `busctl` property reads on `org.a11y.Bus` in the proof), but a tree walk is thousands of calls and the Collection interface's match rules are awkward to marshal from the shell; the typelib is one small distro package. Kept as the fallback if a target distro lacks the typelib.
- **`ydotool` (kernel uinput) to reach Wayland.** Not chosen: it needs root or the `input` group, injects into whatever has focus with no way to check which window that is (Wayland gives no global active-window query), and AT-SPI extents are not global screen coordinates on Wayland. It would break the "input only into the bound window" rule.
- **The XDG RemoteDesktop portal / libei on Wayland.** Not chosen for the first version: it asks the person at the screen for consent per session (a good fit for the presence rules, a poor fit for an unattended VM), and the active-window and coordinate problems remain. Weighed again only when an operator's Linux machine is Wayland-only.
- **Playwright with a "stealth" configuration.** Rejected by the skill's founding rule: an automated browser presented as a person.
- **One wrapper for Windows and Linux.** Rejected for the same reason the cross-platform spec kept two command surfaces: the mechanisms differ (bridge, session 0, UIA vs X11, AT-SPI); a merged script would be harder to test on either.

## Side effects and rollback

- Existing Linux agents: two new scripts, changed skill text and card; nothing runs until invoked. macOS and Windows agents: changed refusal text and skill text only.
- On the Linux machine, a launch creates the profile directory under the agent home and a Chrome process with accessibility on (higher renderer CPU and memory on heavy pages: not measured yet, a live-test row).
- Rollback: revert the release. The scripts are inert; the skill copy keeps the Linux section until the next update (the old migrator does not touch it); the card follows the same revert behaviour as the cross-platform spec describes.

## Maturation plan

- **test-agent-live:** Cirrus (X11, XFCE on TigerVNC), the live gate above.
- **dev-agent-live:** Echo's macOS home gets the scripts (inert there) and the skill text; the first Linux agent to use it is Cirrus.
- **fleet:** the release that carries it, ungated (each script refuses the wrong platform).
- **graduation criterion:** within 14 days of the release, one operator-requested browser task completes through `xdrive.sh` on a Linux agent, verified by re-reading the document URI and a matching activity line. A zero count is not a pass.

## Open questions

1. **Is a Chrome with accessibility on distinguishable to a site's passive scoring?** `navigator.webdriver` is unaffected and no port opens; but full accessibility mode changes performance characteristics. Is there any public signal a page can read? The live test can only show that pages still work, not that scoring is unchanged.
2. **Wayland posture:** refuse (this draft) or build the RemoteDesktop-portal route now? Which operator Linux machines are Wayland-only?
3. **`invoke` and user activation:** does AT-SPI `do_action` on a button give the page user activation in Chrome? The answer decides whether `invoke` may be used for OAuth-style buttons.
4. **Secret typing through `libXtst` ctypes** vs `xdotool type --file -` (stdin, no argv): which is simpler to test, and how do both behave on a non-US layout?
5. **Profile jail on Linux:** agent home only (this draft, like macOS), or also a declared profile root (Cirrus already has a `~/.config/chrome-instar` profile outside the agent home that the operator set up)?
6. **Dependency install:** the wrapper refuses and prints the install line; should `instar init` on Linux check for the AT-SPI typelib and say so up front? (On Cirrus it needed sudo.)
7. **Operator presence on a VNC display:** is X idle time the right signal when the operator watches through a viewer without touching it? Watching is not input, so the driver may act while they watch; is that what the operator wants?
8. **Second live host:** which machine provides the GNOME Wayland refusal test and a non-VNC X11 desktop?
