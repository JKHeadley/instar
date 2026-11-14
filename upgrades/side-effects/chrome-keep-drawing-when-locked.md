# Side effects: agent-launched Chrome keeps drawing on a locked screen

`chrome-launch.sh` (macOS normal-Chrome launcher, installed into `.instar/scripts/browser/` and overwritten on every update) now adds two fixed Chrome rendering flags, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`.

Measured cause (Studio, 2026-11-03 19:20 PST, screen locked per IOConsoleUsers `CGSSessionScreenIsLocked=true`): macOS reports every Chrome window as occluded, so the tab's `visibilityState` is `hidden`, `requestAnimationFrame` never fires, and timers are throttled to about 1 s. Slack's app-settings page loaded all its data (every API call returned 200) but stayed on a spinner. A throwaway profile launched with these flags reported `visible` and rAF fired in 1 ms while still locked. The real profile, relaunched with them, rendered the page fully and the Slack reconnect finished with the screen still locked. Justin (topic 134088, 19:11): "a locked machine should never block us".

1. Over-block: none. It refuses nothing.
2. Under-block: a Chrome already running is not relaunched; it gets the flags at its next launch. Pages that check `document.hasFocus()` or OS focus are unaffected (focus is unchanged).
3. Level of abstraction: the launcher is the one place every agent-opened normal Chrome starts, so it is the right layer.
4. Signal vs authority: no decision point.
5. Interactions: background tabs use somewhat more CPU, since they keep rendering. The launcher still adds no debug port and no automation flag, and the caller still cannot pass flags (the url-slot check is unchanged). A test pins that no remote-debugging, enable-automation, headless or webdriver flag is present.
6. External surfaces: sites see an ordinary visible tab, not an automated browser.
7. Multi-machine posture: machine-local by design (each machine launches its own Chrome); the script ships to every agent through the existing always-overwrite migration.
8. Rollback: revert; the next update overwrites the script.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`. It adds a fixed launch argument and no loop.
