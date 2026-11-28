<!-- bump: patch -->

## What Changed

On Windows, an agent running in Linux (WSL) in its usual network setting could refuse to pair a phone over the home network. WSL sometimes gives Linux a different private network instead of the usual 172.16 to 172.31 one, when the PC's own network or a VPN already uses that range. One PC got 192.168.144.x. The agent accepted only the usual range, so Connect your phone stopped with "WSL is in NAT mode but its own NAT address could not be read". The agent now accepts any of the three private ranges (10.x is allowed by the same rule but has not been seen). The address and the router must be in the same range and on the same network, and the interface must have exactly one address. The connection must also be positively Linux's own Windows network adapter (the only Hyper-V network card), so the agent never listens on a VPN or any other non-Hyper-V connection that carries Linux's main route. That is now true in every range, including 172.16 to 172.31, where the old version would have listened on such a VPN. The networking setting is still read, never guessed. In mirrored mode the agent still never listens on the home network's own address.

## What to Tell Your User

If Connect your phone on a Windows PC said the home door stayed closed because of how Linux shares the network, try it again after this update. It should now open on most of those PCs.

## Summary of New Capabilities

Home-network phone pairing works on Windows PCs where WSL uses a 192.168.x private network (and, by the same rule, 10.x).

## Evidence

Reproduced 2026-11-26 in a Windows 11 VM: with the host on 172.24.x, WSL took 192.168.144.0/20 and pairing was refused (`409`). Unit tests cover 192.168.x, 10.x, mixed-block, wrong-subnet, public and two-address cases, mirrored mode never binding a 192.168.x or 10.x LAN address, and VPN-owned default routes (tun0 on 10.8.0.0/24, 192.168.0.0/24 and 172.30.0.0/24) and a second Hyper-V NIC never being bound. The adapter marker is verified on the affected Windows 11 VM before release.
