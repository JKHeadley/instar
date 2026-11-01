# Mac desktop helper holds its own permission: plain overview

Remote desktop on a Mac needs two permissions: Screen Recording, to see the
screen, and Accessibility, to move the mouse and type. We assumed macOS gave
those to Instar's small desktop helper program. It does not. macOS looks up the
chain of programs and holds one of them responsible, and on our Macs that is the
program that started the shared terminal server.

That program depends on which agent happens to start first after a reboot. When
the Laptop rebooted on October 31, a different agent won the race, and it runs a
copy of Node whose Screen Recording switch has been off since October 12. Remote
desktop stopped working even though nothing about the helper had changed. Input
kept working only because that Node is allowed for Accessibility.

The fix has three parts. First, the helper can now start itself in a way that
tells macOS "judge me, not my parent". It stays the same running process, so the
Stop button still ends it instantly. Second, Instar checks both ways on every
readiness check and uses the helper's own permission when it has one, and the
old inherited one otherwise, so no working Mac breaks on update. Third, the
agent can ask macOS to show its permission prompt on a Mac when someone is there
to answer.

For a permission to survive updates, the helper also needs a stable signature.
Without one, macOS ties the permission to one exact build, and any change to the
helper's code would lose it. The release process can now sign with a real Apple
certificate, and Instar's agents can see which kind of permission each Mac has.

What the reader needs to decide: which Apple certificate signs releases. Only
the Apple account holder can create a Developer ID certificate, the proper kind.
Each Mac also needs one tap to allow the helper; that can never be automated,
and that is a good thing.
