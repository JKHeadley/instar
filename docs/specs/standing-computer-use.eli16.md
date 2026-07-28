# ACT-903 Standing Computer Use — ELI16

## What problem this solves

Instar can already use Playwright to read and operate a browser, but that ability is
currently more like borrowing a shared laptop without a reservation system. A session
may discover that a logged-in browser exists, but there is no durable, inspectable
answer to: “Which agent may use it, on which machine, under which account, for what
task, and until when?”

ACT-903 turns that accidental ability into a standing capability with an explicit
operator-signed grant. It extends the browser profile registry, the one-at-a-time
Playwright seat lease, the external-operation gate, and the multi-machine mesh already
in Instar. It does not create a second browser stack or a second permission system.

## What v1 can and cannot do

The first version is intentionally observation-only. It can open one exact URL named
in the signed grant and read a tightly bounded page snapshot or masked screenshot
crop. It cannot click, type, submit a form, navigate again, download, upload, use the
clipboard, enter a password or code, accept terms, make a payment, solve a CAPTCHA, or
control the whole desktop. Those are materially different powers and need a later,
separately converged design.

That narrow start matters because “read-only” browser access can still expose private
mail, health information, payment details, one-time codes, or operator account data.
Every observation therefore passes an origin/privacy gate. The agent gets a small DOM
summary first; only if necessary can it receive one masked, size-capped crop. Full
screens and durable debug recordings do not exist in v1.

## Who grants authority

The operator issues a signed Coordination Mandate from the PIN-protected Mandates
dashboard. One mandate names one requesting agent, one exact seat-host agent and
machine, one browser profile and acting identity, one URL/origin, one purpose, one
model provider/privacy posture, and a short expiry. The agent cannot mint, renew, edit
or widen it. Revoking it stops renewal of a five-second online authorization lease.

The browser profile registry may display “agent” or “operator,” but that label is only
a hint. The signed mandate is the authority, and the seat machine independently
checks that the expected browser profile and live account actually match. If those
facts disagree or cannot be verified, nothing runs.

## How the shared browser seat stays safe

All compliant Playwright users on one machine share the existing host-wide seat
control. ACT-903 hardens it with a server-minted holder secret and a monotonic fence,
so a crashed or expired owner cannot keep issuing commands after a successor takes
over. Profile switching also happens inside the same continuous lease; one drive
cannot silently change the login underneath another.

There is no agent preemption. A busy seat waits with bounded backoff and eventually
stops. The operator can reserve the managed seat or use a PIN-confirmed force release.
The design is honest about its boundary: it coordinates compliant automated callers
and the managed operator-seat toggle, but cannot detect a person independently using
an unrelated browser.

## What happens across machines

Cookies and logged-in profiles stay on the machine that physically owns them. Instar
replicates only tiny signed availability and drive-status summaries. Before the
operator grants access, those summaries can show which machine appears able to host
the task. The signed mandate then freezes one exact host; routing cannot substitute a
different machine later.

For remote work, the model/controller runs with the seat on that host. Raw page text
or pixels never travel through Instar’s mesh or journal. Only a closed, scrubbed result
comes back. Any model-provider request is also constrained by the signed provider,
region, retention and no-training policy; Instar may not silently fall back to a
weaker provider.

## Revocation, evidence, and rollout

The seat host must renew both authority and seat ownership every five seconds, and an
observation itself has a five-second deadline. Under a partition, the honest worst
case after revocation is ten seconds: the remainder of one authority lease plus one
already-started observation. Unknown connectivity never extends authority.

Audit records who/where/when, mandate and decision identifiers, safe action classes,
fences and keyed digests. It never stores screenshots, DOM text, typed values,
cookies, headers, paths or raw URLs. The audit is hash-chained and bounded.

The build plan starts with a blocking audit of every Playwright entrypoint and repairs
the current fail-open lease edges before any new authority exists. Then it runs dark,
dry-run, agent-owned observe-only, and finally separately signed operator-profile
observe-only canaries. Input and effects are not quietly waiting behind a flag; they
are outside this specification.

This PR contains only the specification, its convergence evidence, and this overview.
It does not implement the capability, change Mini provisioning, or touch ACT-896.
