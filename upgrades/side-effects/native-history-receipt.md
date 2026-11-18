# Native history receipt receiver

This increment is stacked on the approved import-from-claude-chatgpt design and the topic 143810 review of the native transport. It adds a private in-process receiver to the acquisition worker. Production supplies no installation, no verifier and no native delivery grant. There is no public route or provider advertisement.

## State and authority

The job database gains a local handoff fence. A private native-captures.sqlite holds capture IDs, job/owner/device/machine bindings, expiry and the first receipt's digest and size. Neither store receives URLs, cookies, message bodies or archive contents. One job is bound to one capture. A lease survives restart and a missing native installation leaves the handoff fenced. The job owner can still cancel the existing import. The private archive publication step now accepts a mandatory digest and count for native input, checks both before publishing, and leaves earlier non-native import behavior intact.

Signed user intent authorizes the existing job. The local Mac still needs live owner-key admission and installation binding. A current operation-specific grant authorizes a transfer; a matching email, a content hash, a file or a WKWebView store UUID alone provides no authority. Errors sent to the caller are finite; the helper's stderr is discarded.

## Side effects and rollback

The opt-in receiver opens an installation-supplied private directory root, a private capture database and a short-lived fixed system helper for verified receipt reads. It observes only the derived capture directory and uses descriptor-relative no-follow opens. The Mac owns its temporary source file. The agent owns the private archive it publishes. Disabling the receiver prevents fresh native capture calls; the job fence persists to prevent a second link redemption. Rolling back to code predating the native job fence must be preceded by cancelling or finishing pilot captures. The feature is currently dark.

The reviewed native transfer, redirect controls and server-signed response pin still require producer integration before production enablement. No personal account or production device was enrolled.

## Multi-machine posture

Machine-local by design. The capture database is tagged history-acquisition-local, and admission requires the caller's machine binding to equal the job's machine: a Mac can hand a capture only to the agent server on the same computer. Nothing replicates. Another machine sees the job's existing status through the importer's normal views and never a capture row or archive.

## Known liveness gap (production-enablement condition)

If the process dies after the archive is published but before the receipt row is marked accepted, and the 15-minute lease runs out before the restart, the boot sweep discards the archive and the job stays at native-capture-pending until the owner cancels it. This fails closed: nothing is copied. Enabling the receiver in production requires reconciling a published archive whose digest matches the lease on boot. The receiver is dark today, so no install can reach this state.

## Second-pass review

Reviewer (independent subagent, 2026-11-17 22:49 PST): Concur with the review. It checked that the receiver stays dark in production (the AgentServer builds the worker without nativeCapture), loopback/forwarder/Host admission, current local-install device binding, receipt replay and conflict after restart, the helper's format-checked arguments and isolated interpreter, no-follow/nlink/mode/size/mtime checks, the digest and size re-check before publication, and that apply still needs the owner's fresh preview confirmation. Focused suites 16/16. Its two non-blocking notes are the two sections above.

## Class-Closure Declaration

- defectClass: unbounded-self-action
- closure: n/a
- reason: One-shot caller-driven action: each signed same-Mac receipt request spawns one bounded reader with a single expiry timer; no retry, respawn or self-triggered loop. Periodic acquisition work stays under the parent's registered convergence guard.
