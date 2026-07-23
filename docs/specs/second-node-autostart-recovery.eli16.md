# Second-node autostart recovery: ELI16

Imagine a standby computer has a valid ignition key but its starter switch was
turned off. Reinstalling the starter replaced all the right parts, then tried
to start the engine without turning the switch back on. macOS returned a vague
error, and the standby computer stayed absent.

There was a second trap in the repair path. Instar keeps a stable shortcut to
Node so upgrades do not break startup. If the repair command itself was launched
through that shortcut, it could choose the shortcut as its own destination.
That is like replacing a road sign with another sign pointing back to itself:
the real road becomes unreachable.

The installer now turns the exact service switch back on before asking macOS
to start it. It also searches all Node locations on PATH and refuses to use its
managed shortcut as the shortcut's target. A paired standby can therefore
recover into the live pool after being disabled, without corrupting its next
boot.

