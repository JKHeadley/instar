# Echo mesh remote desktop, explained simply

Open [Echo's Desktop page](https://echo-studio.dawn-tunnel.dev/dashboard/desktop.html)
on your phone or laptop and enter your usual dashboard
PIN. You see your five machines by name. Choose one that says it is ready, and
its desktop appears in the same viewer you use for Mac Studio. You can point,
click, drag, scroll, type, zoom, and press **Stop**. A machine with an
unavailable screen helper stays in the list with a reason you can understand.
The page never silently opens a different machine.

Your PIN unlocks the dashboard; it does not unlock a computer's operating
system. Echo asks the chosen machine for a short, one-time permission that is
valid only for that machine and that browser session. The chosen machine checks
the request itself before it sends a screen or accepts input. Only one person
can control a physical machine at a time. Access ends when you press Stop,
disconnect, or reach the ten-minute limit. After Stop, the old controls cannot
keep sending clicks or keys.

Mama PC needs a small Instar companion running in its signed-in Windows
session because Echo itself runs inside WSL, which cannot see the Windows
desktop. The companion has no public remote-desktop port. Echo installs and
updates it as part of turning on this feature, then checks that it can really
capture and control Windows before marking Mama PC ready.
If WSL cannot contact an already running companion during an update, Echo
tries the same signed update request from Windows itself. The running
companion must still issue a one-use permission to exit, and Windows must
confirm it stopped before Echo replaces it. If either check fails, Mama PC
stays unavailable in the picker and Echo reports a short failure code. You
still only use the dashboard PIN; there is no extra Windows setup step.

An online Mac agent can still have an unavailable screen helper. That does
not mean the whole Mac is locked or that Echo lost contact with it. Echo now
reports the helper's display, permission, and console-session checks
separately so we can fix the right problem. On Mama PC, Echo sends desktop
requests through Windows itself to a companion listening only on that
machine's loopback address. Windows does not need to ask you to allow a
network connection for the companion.

Mac Studio is the single entry point for this first Echo mesh rollout. It
relays a chosen machine's encrypted screen and controls without becoming that
machine's controller. The feature is ready to test on a machine only after a
real screen, input, Stop, and refused-after-Stop check passes there. Linux
desktops outside Mama PC's Windows host are outside this rollout.
