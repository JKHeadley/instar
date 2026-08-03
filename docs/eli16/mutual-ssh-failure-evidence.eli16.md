# ELI16 — Keep the clue when mutual SSH setup fails

Instar can connect two machines belonging to the same agent over a dedicated SSH
channel. During setup, several things can fail: the local listener might not
start, the machines might not exchange their connection descriptions, a standing
key might not install, or a later reachability probe might fail.

The existing code turns each error into a short category such as timeout, port
collision, or admission refused. Categories are useful because they are stable,
but they are not the whole diagnosis. If an error did not contain one of the
classifier's known phrases, the code saved only the category “unknown.” The
original error had already been caught, but its message was discarded. The live
status could therefore prove setup was genuinely blocked while giving the
operator no clue about the cause.

This fix keeps both pieces. The old category remains exactly as it was, and a
second field keeps a short, cleaned copy of the original error message. The
cleaning happens before the detail reaches a status, audit, or notification
surface. It removes known credential shapes, private and public SSH key
material, home-directory identity, IP addresses, and hostnames identified in
SSH/DNS endpoint contexts. That context requirement matters: ordinary dotted
JavaScript names such as `fs.readFileSync` and filenames such as `package.json`
remain useful diagnostic evidence instead of being mistaken for machines.
It also removes control characters and stops at 512 characters. The failure
class is still computed from the original message, so privacy cleaning cannot
silently change which category the system chooses.

The test creates a listener failure that deliberately matches no existing
category. Before the fix, the received state contains a false listener, a
blocked enrollment state, and the single word unknown—with no failure object.
After the fix, the same reproduction contains unknown plus a diagnostic detail.
The test embeds a fake machine hostname and fake private key in the thrown error,
then proves neither survives into that detail and proves the size bound holds.

This does not make SSH enrollment more permissive or more restrictive. It does
not add a category to fit today's incident. It does not change retries, circuit
breakers, readiness, key installation, peer execution, or routing. On a healthy
single-machine agent, the status remains unchanged and does not gain an empty
diagnostic field. The only new behavior is that when a real caught failure is
already being surfaced, its safe evidence is no longer thrown away.
