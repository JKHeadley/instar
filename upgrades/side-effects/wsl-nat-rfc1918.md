# Side-Effects Review — WSL NAT home-pairing address check accepts any RFC 1918 block

**Version / slug:** `wsl-nat-rfc1918`
**Date:** `2026-11-26`
**Author:** `Echo (Windows App project, topic 144319)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`wslNatAddress()` in `src/core/SameNetworkNetwork.ts` is the shape check that finds WSL's own NAT address. The home listener binds that address when the agent runs inside WSL in NAT mode. The check used to accept only 172.16.0.0/12. WSL picks another private range for its NAT network when the PC's own network or a VPN already uses 172.16/12: 192.168.144.0/20 was observed, and 10/8 is accepted by the same rule but has not been observed. On 2026-11-26 a Windows 11 VM whose host was on 172.24.x gave WSL 192.168.144.0/20, and Connect your phone was refused with `409` "WSL is in NAT mode but its own NAT address could not be read", in one run of two. This change accepts any RFC 1918 block (10/8, 172.16/12, 192.168/16). The default-route interface must still have exactly one non-loopback IPv4 address, and that address and the router must sit in the SAME block and on that interface's subnet. A new exported helper, `rfc1918Block()`, names the block. A second helper, `isWslNatAdapter()`, requires the default-route interface to be POSITIVELY WSL's own NAT adapter: `/sys/class/net/<iface>/device/driver` must resolve to `hv_netvsc`. The identity session ruled this on 2026-11-26 (message 163a07b2), after the second-pass review found the VPN case below. The identity session approved the requirement on 2026-11-26 (topic 144636, message 39a4fdcf). Files: `src/core/SameNetworkNetwork.ts`, `tests/unit/same-network-network.test.ts`, `tests/unit/same-network-wsl-mode.test.ts`, the spec `docs/specs/identity-security-piece3e-same-network-first-phone.md` §3.1 and its ELI16 companion. Tier 2 (identity and security surface). Size: 3 source and test files plus the spec and its ELI16, about 65 lines.

## Decision-point inventory

- `wslNatAddress` (shape check, src/core/SameNetworkNetwork.ts) — modify — accepts every RFC 1918 block instead of 172.16/12 only, with the same-block and same-subnet requirement.
- `wslBindPlan` (the bind decision) — pass-through, unchanged — it still binds the NAT address only when the mode READ is `nat`. In mirrored mode it binds loopback only, and only when the Windows app says it handles the network rule. Otherwise it stays closed.
- `readWslNetworkingMode` (the mode reading) — pass-through, unchanged — wslinfo, then .wslconfig, failing closed to unknown.
- `isWslNatAdapter` (new positive adapter identification) — add — the default-route interface must be a Hyper-V synthetic NIC (`hv_netvsc`). Otherwise there is no NAT address and the bind stays closed.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

It rejects fewer private ranges than before, and adds one new fail-closed refusal. Newly refused: any default-route interface that is not positively the only Hyper-V synthetic NIC (driver `hv_netvsc`). That covers an unexpected `/sys` read error on any interface (as opposed to the expected ENOENT of a virtual interface, which means "not Hyper-V"), an unlistable `/sys/class/net`, a bridge, VLAN, macvlan or tunnel carrying the default route, another NIC driver, and two Hyper-V NICs. A user who bridged eth0 inside WSL would now be refused home pairing; that is the safe direction and not a known WSL setup. Still refused, as before: a NAT network on public or CGNAT space (100.64/10), which WSL does not use; a default-route interface with two or more IPv4 addresses; and a router in a different block or subnet from the address. A WSL NAT setup with a secondary address on eth0 would still be refused, as before. That case has not been observed.

---

## 2. Under-block

**What failure modes does this still miss?**

The real cost. Before, a mirrored WSL on a 10.x or 192.168.x home network failed the shape check, so even a WRONG mode reading of `nat` could not bind the LAN address. Now it passes the shape check, and the mode reading is the only thing that keeps it from being bound with the per-address limit off. That was already the stated rule (builder #45: "NAT mode is READ, never inferred from the address range"), and a mirrored WSL on a 172.16/12 home network already depended on the reading alone. The reading's failure modes are unchanged: `wslinfo` is authoritative where it exists (WSL 2.0+), and `.wslconfig` is used only when it was not changed after WSL started (with a 10-minute clock margin), else unknown and closed. The identity session accepted this trade-off explicitly.

Closed by the adapter check: the second-pass review found that, in NAT mode, the default-route interface is not always WSL's own adapter. A VPN client inside WSL that replaces the default route (for example tun0, 10.8.0.2/24, router 10.8.0.1) has the shape. Binding it with the per-address limit off would expose the listener to the VPN's side. The first build already had this exposure for a VPN on 172.16/12, and the widening would have extended it. `isWslNatAdapter` now refuses every interface whose device driver is not `hv_netvsc`. Tunnels have no device link, so they are refused in every range, including 172.16/12. This closes a pre-existing under-block as well. Remaining under-block: a second Hyper-V NIC that some other software attaches to the WSL VM would also be `hv_netvsc`. That has not been seen in WSL 2, which gives Linux one synthetic NIC in NAT mode, and the mode reading plus the same-subnet rule still apply. Verification of the marker on the affected Windows 11 VM is recorded below before ship.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The shape check and the new adapter check are cheap structural detectors inside `wslNatAddress`, which feeds the bind plan, and the bind plan is the authority. Both fail closed, which means no NAT address and the listener stays shut. The adapter check is a new structural floor alongside the shape check, at the same layer, not a parallel gate elsewhere.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing gate (the bind plan): `wslNatAddress` returns an address or null.
- [ ] No — this change has no new block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The shape check is a fail-closed input to `wslBindPlan`. The change relaxes it from one private block to three, and adds a fail-closed positive-identification floor (`isWslNatAdapter`). Both are deterministic security floors on kernel-provided facts, the kind of structural check that belongs at a floor, not a judgment. No new authority is added: the bind plan still decides.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?**

No. These are structural safety floors on network shape (RFC 1918 membership, same block, same subnet, one address) and adapter identity (the only `hv_netvsc` NIC), not a competing-signals judgment. It stays a deterministic floor by design.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

`sameNetworkListener.ts` calls `wslNatAddress` on `/proc/net/route` and `os.networkInterfaces()` with the same two arguments. The default adapter check now also reads `/sys/class/net` at that moment, a few small synchronous reads, only when a WSL home listener opens. `wslBindPlan` and the listener tests inject their own address and are unaffected. One existing unit assertion changed meaning: a mirrored-shaped 192.168.1.20 LAN address now passes the shape check. The test now says so, and `same-network-wsl-mode.test.ts` gains assertions that `wslBindPlan` never binds 192.168.x or 10.x LAN addresses in mirrored, other or unknown mode. `PeerEndpointResolver.ts` has its own RFC 1918 check, unrelated and untouched. No double-fire and no shadowing were identified.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

Yes, for the better. On Windows PCs where WSL's NAT network is 10.x or 192.168.x, Connect your phone now opens the home listener instead of answering `409`. `GET /mobile/same-network` reports `bind` as before, now with that address. The Windows app's refusal wording is a separate change in the Windows app repository (rough-edges batch 2, item 7), tracked by commitment CMT-043. No other agent or user surface changes. It depends on WSL's runtime routing table, as before.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or grant form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The NAT address is a fact about one machine's WSL network, read fresh at each listener open. It must never be replicated. No user-facing notices, no durable state, no generated URLs. Status surfaces: `GET /mobile/same-network` (`bind`, `wslMode`) is unchanged in shape and stays this machine's answer.

---

## 8. Rollback cost

Pure code change: revert the commit and ship a patch. No persistent state and no migration. During a rollback window, affected Windows PCs return to the old refusal. No other user sees a change.

---

## Conclusion

The review found one trade-off and one exposure, both stated in §2 and in the spec. The trade-off: the mode reading becomes the only guard against mirrored-mode LAN binding on 10.x and 192.168.x home networks, as it already was on 172.16/12 ones. The identity owner accepted it. The exposure: a VPN inside WSL that owns the default route. It led to a design change: a positive adapter check (`hv_netvsc`), ruled by the identity owner, which also closes the old 172.16/12 VPN case. Clear to ship after the second-pass review and Identity's spec and PR review, then a Windows pairing re-run in the affected NAT range from the merged build (commitment CMT-043).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus, static reading only, 2026-11-26 18:40 PT)
**Independent read of the artifact (round 1): concur, with two concerns, both resolved**

- Concurred: the code implements exactly the approved requirement. `readWslNetworkingMode`, `wslBindPlan` and the listener are untouched. `rfc1918Block` refuses CGNAT, link-local and loopback. No path lets a mirrored WSL bind a LAN address unless the mode reading misreports, which predates this change. The hex fixtures are correct.
- Concern: no test isolated the same-block rule (every cross-block case was also cross-subnet). Resolved: cases with netmask 128.0.0.0 and 0.0.0.0, where only the block rule refuses, were added.
- Concern: the stated cost omitted an in-WSL VPN that replaces the default route on 10/8 or 192.168/16. Resolved: the cost is added to the spec, the ELI16 and §2 above, and the question was sent to the identity session. Minor wording fixes: "same network" rather than "same small network", and the Windows-app recovery is now described as a separate change in the app repository.

**Round 2 (same reviewer, after the identity ruling 163a07b2 added the adapter check): concur on the marker, names, callers and tests; three concerns, all resolved.**

- Concern: two `hv_netvsc` NICs would bind whichever owned the default route, not close as the ruling requires. Resolved: `isWslNatAdapter` now requires exactly one Hyper-V NIC, and that it is the default-route interface. An unlistable `/sys/class/net` closes the bind. Tests cover both.
- Concern: no test pinned the default adapter check. Resolved: a test spies on `fs.realpathSync` and `fs.readdirSync`, calls `wslNatAddress` with two arguments, and checks that a hv_netvsc eth0 binds and a tun0 does not.
- Concern: the docs overstated what the adapter check guards. Resolved: the spec and ELI16 now say the READ mode guards mirrored and bridged (those NICs are Hyper-V NICs too), and the adapter check guards tunnels and other virtual interfaces. The approved-by line, this artifact, the release note and the misplaced doc comment were all brought up to date.

---

**Identity session spec review (message d5c43591, 2026-11-26 18:49 PT): acceptable for implementation and VM verification; three clarifications made.** (1) Observed versus supported: only 192.168.144.0/20 was observed, and 10/8 is described as accepted but not observed. (2) The adapter claim is scoped to default routes on VPN tunnels or other non-Hyper-V interfaces, and it is a separate requirement from the trusted mode read. (3) An expected absent device link (ENOENT on a virtual interface, meaning "not Hyper-V") is distinguished from an unexpected read error, which prevents establishing uniqueness and closes the bind. The code changed for (3): before, any error on another interface counted as "not Hyper-V". A test covers EACCES on a second interface.

## Evidence pointers

- Adapter marker VERIFIED on the affected Windows 11 VM, 2026-11-26 18:46 to 19:13 PT (worker echo-windows-nat-adapter-verify; evidence on Mama at ~/winapp-work/natid/report.md and raw/00 to 50). Fresh copy of InstarWin11Test, WSL 3.0.5 (Microsoft-signed MSI), Ubuntu 26.04.1, kernel 6.18.58.1-microsoft-standard-WSL2. In NAT mode, the default-route eth0 (172.24.209.116/20 via 172.24.208.1) had device/driver resolving to /sys/bus/vmbus/drivers/hv_netvsc, uevent DRIVER=hv_netvsc, and VMBus class_id {f8615163-df3e-46c5-913f-f2d2f965ed0e}. It was the only hv_netvsc NIC: the VMBus device-to-netdev map in raw/10 shows one (VMBus 144d8915-fe95-4786-8440-e1b94dfad591 to eth0), and it stayed the only one with each tunnel up (raw/20 to 23). In mirrored mode the map shows two (eth0 and loopback0, raw/40). The gateway equals Windows' "vEthernet (WSL (Hyper-V firewall))" address, 172.24.208.1. Four VPN-owned default routes (tun0 and wg0, each on 10.8.0.0/24 and 172.30.0.0/24) were all type 65534, with no device and no driver link. Trap noted: `readlink -f /sys/class/net/tun0/device` prints a NON-EXISTENT path with exit 0. The code uses Node's `fs.realpathSync`, which fails with ENOENT on a missing component, read as "not Hyper-V", and it compares only the driver basename. Mirrored mode: eth0 is also hv_netvsc, and a SECOND hv_netvsc device, loopback0, appears. The uniqueness rule would refuse there, but the listener reads the NAT address only when the mode read is `nat`, so mirrored mode behaves as before, binding loopback only behind the app's network rule. Mama's own WSL is also hv_netvsc (raw/mama-wsl-selftest.txt). The VM copy was removed afterwards and the other VMs were unchanged.

- Live failure: Mama PC `~/winapp-work/reproof/report.md` (2026-11-26, run 1 refused with WSL on 192.168.144.0/20; run 2 passed with 172.22.x; mirrored passed both).
- Identity approval: message 39a4fdcf from session echo-topic-144636, 2026-11-26 18:3x PT.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: not applicable. This is a source-code range check. It is not an LLM prompt, hook, config, skill or standards text, and not a self-triggered controller.
