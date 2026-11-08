# Disposable two-host recovery qualification — 2026-11-06

The recreated M5 agent and a replacement Mac Mini fixture were isolated, expiring real agents. The M4 timed out from the Studio and M5; no laptop test agent was started. Both fixtures used their own host keys, restricted SSH daemon, ports, recovery services, test watchdog and independent cleanup deadline. Production services and keys were outside their scope.

Verified live:

- SSH stop, main-down diagnostics, start and healthy status.
- The same cycle through the public HTTPS relay while a per-process sandbox denied all direct outbound connections. Its only allowed carrier was a localhost CONNECT proxy restricted to that relay. This demonstrates authenticated relay operations under direct-path loss; proxied requests do not qualify source socket independence.
- A real owned-watchdog kill loop rescued over SSH, then over the isolated relay. The relay round admitted hold before the ten-kill cap, started the main, verified stable health and restored the owned watchdog within its60 second hold. The earlier failed mailbox-cap round is not counted as a pass.
- The entire Mini mutable test package was renamed out of the way for 80.471 seconds. Its sidecar was killed and cold-started from copied Node, code and native dependencies. Both carriers continued answering authenticated status. The package was restored in a controller finally block before expiry.
- Owner-signed repair rearm advanced the target epoch; route removal stayed pending until target installation. Each acknowledged route removal refused that route while the other remained usable. Both were regranted without another repair-epoch reset.
- Final actual-socket proofs in both directions: M5 SSH `utun6` / relay `en0`; Mini SSH `utun4` / relay `en1`. Both targets signed independent-runtime evidence and finite repair availability.

`cold-signed-proofs.jsonl` retains six earlier signed cold-window status exchanges. The source observation algorithm was subsequently hardened to bind the actual authenticated socket. The two `final-…proofs` files contain the later socket-bound exchanges in both directions. `relay-killloop.jsonl` retains the successful isolated carrier round, and `cold-host-report.json` records the target-side rename/restart and restoration observations. These are historical test records, not current readiness and never production authority. The public key inventory contains only disposable public keys.

After building, run `node scripts/recovery-test/verify-evidence.mjs` to independently verify all ten retained request, target-response and source-observation signatures and digest bindings.

The Mini's six owned services were removed at 10:25:54 PST; the M5's owned services were also removed. Both fixtures' main/SSH ports were confirmed closed. The temporary DNS record, Cloudflare tunnel and local relay were removed/stopped. No deadline was extended. Production helper PIDs and shared SSH/LaunchAgent state on the Mini were unchanged after the keep-awake ownership fix.

Limits: this was not a physical shared-host reboot or production phone enrollment. Production-entrypoint tests separately cover durable boot uncertainty, protected service/binding updates, rollback, failed installation, revocation, uninstall races, native cold loading and bounded slot cleanup. Final source continued receiving reviewed installation/storage safety fixes after the live cold-window trial; CI and the final test summary apply to that source revision.

Phone review: [setup](phone-setup.png), [connected owner controls](phone-owner.png) and [measured390×844 layout](phone-layout.json). Real browser review found and corrected hidden-link visibility, primary action order and a small disclosure tap target. The functional phone test separately exercises signed enrollment with a lost response, grant retry, revocation and a revoked saved key on reload.

The mandatory push fixture check also passed both environment modes: restricted-host fail-closed supervision and the real M5 supervised restart-to-ready path. [Environment evidence](gate-environment.json) records exact source/file hashes.
