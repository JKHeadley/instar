# Rebuild any machine in one step, in plain words

Echo and Luna each live on several computers at once. When one of those computers dies, the agent
should keep going on the others, and the dead computer should be easy to bring back. On 20 November
the Mac Studio had to be erased and set up again from nothing. Bringing it back took about two hours
of careful hand work by Echo, and a lot was still quietly missing afterwards: the settings that let
pull requests merge, the record of who the owner is, the private-group record, the paired phones, a git
remote, the signed-in browsers, the machines' ability to log in to each other, the Mac's privacy
permissions, and even the right version of Node. Each missing piece was found only when something
broke, some a day later. Two of the other computers never learned that the Studio was back, and one
of them held every message it tried to send for eight hours.

This spec turns that into one step. The owner says "rebuild the Studio". Echo, on any computer that
still works, finds the fresh Mac on the home network by its name, so nobody has to look up an address.
The owner does three things at the Mac: log in, turn on Remote Login, and open a link on their phone
that shows the Mac's name (so they can check it is the right one) and asks for the login password.
After a fresh macOS install, a short code then appears on the Mac's screen, and the owner replies with
that code on the phone. The code is created on the Mac and checked in a way that neither the Mac nor any agent session can fake, so
that one reply proves the owner is standing at that Mac, and it is also the
owner's yes to letting this machine back into the agent. When only the agent's folder was wiped, as in
the monthly practice drill, the Mac still holds its own secret key, so nothing is asked at all; that last
part arrives with one specific step of the build (moving the machines' repair access out of the agent
folder), and until then the drill uses the same three steps and counts them.

Then Echo does everything else, checking each step against the real machine before moving on: the
tools (including the exact Node version the other machines use), the code with all its remotes and
unpushed work, the secrets before they are needed, the settings (from a list that says which settings
are shared and which belong to one machine, compared across all the machines so one machine's loss is
not copied), the important records, the accounts it can sign in, and the machines' ability to reach and
repair each other in both directions.

While this happens the new machine is kept on a leash that the whole pool knows about. It may not take
over as the lead, read Telegram, run jobs, create topics or send notices. That is what went wrong with
Luna: her half-built server took over, created four duplicate topics and posted failure notices. The
leash comes off when the checks that matter for reaching the owner pass: every machine knows the new
one, its secrets and settings and records match, and a test message gets a real answer. Everything
else (a tunnel, a missing backup copy, an account that needs a passkey) becomes an item on the owner's
list and keeps being fixed, but does not keep a working machine out of the pool.

Some things only a person can do, and the spec says so up front. The Mac's privacy permissions (letting
the agent control Chrome, see the screen, and reach other machines on the home network) are reset by a
reinstall and can only be given by a tap on the Mac's own screen. Echo checks each one the way the
agent really uses it, not from a shell where it looks fine, raises the permission prompt itself where
macOS allows, and puts each missing one on one list on the owner's phone, by name.

Two more things are fixed along the way. When a machine joins or is replaced, every machine in the pool
now learns about it through a signed record passed from machine to machine, and any setting that names
the old machine is pointed at the new one. And emergency fixes made by hand to the installed code are
written down in a register: an update either keeps the fix, drops it only after checking the new version
really contains it, or waits and says so. A change nobody wrote down is always saved before anything
can overwrite it, so it is never lost, and it never blocks an update.

The proof is a monthly drill: wipe a spare machine, rebuild it in one step, and check that nothing is
missing, nothing was duplicated, and nobody had to do more than the steps predicted in advance.
