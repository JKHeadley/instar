# Echo mesh remote desktop extension

Status: implementation plan, 2026-10-30. Extends the approved
`blocker-handoff-across-machines-and-surfaces` remote desktop design and the
working Mac Studio preview. The operator opens the existing dashboard, enters
the existing PIN, selects a machine, and uses Stop. A blocker or Telegram step
is not required.

Plain-language companion: `native-remote-desktop-echo-mesh.eli16.md`.

## Scope and current evidence

Echo's registered pool has five machines: Mac Studio, Mac Mini, Laptop, Mac M5
Pro, and Mama PC. All five were online on 2026-10-30. Only Mac Studio had the
desktop route and live Mac capture/input/revocation proof. The other four
returned 404 for desktop availability. Mama PC's Instar process is Linux/WSL
on a Windows host, so Linux screen capture inside WSL cannot control the
Windows desktop. These are availability observations, not permission probes.

## Routing and authority

The dashboard front lists registered pool machines by stable machine id and
nickname. It shows a machine as available only after a fresh, bounded target
probe verifies its identity, active desktop, capture/input permissions, and
control capacity. Offline, headless, locked, and unprepared machines remain
visible with a plain reason and disabled Open control. No peer URL or raw PIN
appears in the browser's machine list.

For the first Echo rollout, every host names one registered
`remoteDesktop.frontMachineId` (Mac Studio). Only that machine serves the
browser desktop entry point, and every target admits operator assertions only
from that signed machine identity. The front admits at most three concurrent
remote requests, counting in-flight begins, and reserves the fourth pool slot
for its own desktop. A front process waits 25 seconds after boot before
admitting remote requests, longer than the target's 20-second delegated-session
liveness, so a restart cannot immediately double-count old grants. The
designated front is a deployment setting, not a browser choice; changing it
requires coordinated configuration and the same quarantine. If the front is
unavailable, remote control is unavailable until the operator's agent restores
it. Other machine dashboards remain dark for local desktop admission while
their target endpoints can still serve the designated front.

The front validates the PIN once and issues a short lived, single use,
Ed25519 signed operator assertion naming the exact target machine, browser
ephemeral key digest, nonce, and operation. The target checks the issuer
against its registered pool key and the authenticated peer transport, then
creates a target local operator session. It binds its own signed grant to that
session, target identity, browser key, controller lock, and existing ten minute
maximum. The target rechecks local session validity, permission, expiry,
revocation, and controller ownership for every capture and input action. A
relay bearer token, a machine id in a body, or an agent request alone cannot
create a desktop grant.

The front relays bounded HTTP control calls and the encrypted WebSocket bytes
to the selected target through an authenticated pool route. It does not decode
screens or input. The target performs the browser key exchange and signs its
identity for browser pinning. Stop closes the browser stream immediately and
revokes at the target; relay loss also closes input at the target's heartbeat
deadline. A peer partition cannot silently move a live grant to another host.
Existing pool terminal streams and read only private view links are not used
as remote input authority.

Mama PC has only a Tailscale endpoint in the reachable roster. The desktop
relay's narrow route may use its `100.64.0.0/10` HTTP endpoint only when the
local Tailscale daemon reports that exact peer IP online with a node key. The
tailnet supplies transport encryption; the target still authenticates every
machine-signed request, and the browser pins the target's signed desktop
grant. Daemon failure, an offline or mismatched IP, redirect, or an endpoint
merely labeled `last-known-url` leaves the desktop route dark. The general
Bearer credential guard stays unchanged and still refuses CGNAT HTTP.

## Host adapters

The three additional Macs use the packaged Mac capture/input helper and the
same host local control lock as the Studio. Each needs a live foreground login
session plus Screen Recording and Accessibility permission for its own Instar
process. A locked or signed out Mac is reported unavailable; the PIN does not
unlock macOS.

Mama PC needs a separately installed Windows companion launched in the
interactive Windows session and paired to its WSL Instar agent. The companion
owns Windows capture, input, permission and single controller state. WSL
never treats its Linux display as the Windows desktop. The companion's IPC is
local and authenticated; it exposes no VNC/RDP service or public port. A
missing companion, inactive Windows session, or failed input/capture probe is
a truthful unavailable state.

The companion binds Windows loopback only. Instar sends signed requests from
WSL through a bounded Windows-local process, so it does not need a listener on
the WSL gateway. This also avoids a Windows Firewall permission dialog that
would interrupt the remote viewer. During an update from an older companion,
the installer may contact its previous Windows-owned private gateway to obtain
the one-use update token. Discovery accepts that legacy address only while
Windows still owns it; a missing or stale file leaves desktop access dark.
A persisted address cannot redirect authenticated companion traffic to another
host. The Bearer-only
`GET /desktop/diagnostics` route reports this host's probe booleans or a
sanitized probe error without exposing screen content, input, or keys.
If Windows companion installation fails during WSL boot, it reports a fixed
installer phase and failure code there as well. The raw PowerShell output,
paths, addresses, and companion secret remain local. A failed installer keeps
the target dark while the WSL agent itself continues serving normally.

The Mac helper's console-session check is a property of the helper process.
A local diagnostic reports whether the helper received a session dictionary,
whether that session is on console, whether login completed, and whether that
session reports a locked screen. These booleans are authenticated maintenance
data, never a new admission route.
A false result alone does not prove that the whole Mac is locked. Diagnosis
must distinguish an absent GUI session, a helper launched outside the GUI
session, missing permissions, and a missing display before describing the
machine state to the operator. The signed target availability response uses
these exact session fields to explain the machine picker, so Studio can
distinguish the failure without another remote maintenance credential.
When the helper reports a locked console and missing permissions together,
the picker reports both signals; the agent's reachability remains separate.
Instar's agent remains reachable while its screen helper is unavailable.

On WSL boot after explicit desktop opt-in, the agent stages and compiles the
companion before asking an existing process to release control. An update
token authorizes that exact process to exit; Task Scheduler must confirm it
stopped before the binary is replaced. A process-owned installer lock and
bounded preparation timeout prevent concurrent or stranded updates. Each
When the WSL-to-Windows signed prepare request times out, the installer may
invoke a Windows-local signed request to the prior companion on a Windows-owned
address. It uses the existing shared secret, one-use update token, and Task
Scheduler stopped-state check. It never treats a timeout as permission to
replace an active executable. This fallback is bounded and emits fixed
diagnostic codes without returning paths, addresses, or secret material.
Each
machine's opt-in takes effect after a supervised server restart, which briefly
interrupts its existing connections; the dashboard front waits 25 seconds
before admitting new remote grants after restart.

## Release order and proof

1. Merge the Mac preview through the package update path. An automatic 1.3.1507
   refresh erased its local overlay, proving that an overlay is not durable.
2. Add pool target discovery and target bound operator delegation with unit,
   HTTP integration, and production boot tests, including wrong target,
   replay, expiry, offline peer, and partition refusals.
3. Add a bounded desktop stream relay. Verify ciphertext forwarding, Stop,
   target crash, reconnect, backpressure, and control plane reservation on
   two real Macs before enabling the other Mac cards.
4. Package and live test the Windows companion on Mama PC, including WSL
   pairing, actual screen/input, held control release, and revocation.
5. Verify PIN to stream, click, drag, scroll, typing, Stop, and post Stop input
   refusal on every advertised host. Keep each host dark until its own proof
   passes. "All Echo machines" means all five registered hosts; it does not
   claim general Linux desktop support or AnyDesk parity.

The browser and target enforce the approved one controller per physical host,
four streams per pool, bounded frames and inputs, idle expiry, ten minute
grant ceiling, and immediate revocation. Screen and input contents never enter
durable logs or mesh state.
