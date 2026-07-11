# Dangerous-command SQL statement shaping — ELI16

The safety hook used to scan every character of a command and stop whenever it saw certain database words—even when those words were inside a note, search, JSON body, or message. It now asks a more precise question: does this look like the beginning of a destructive SQL statement, followed by the thing it would act on?

Real and ambiguous statement shapes still stop. Ordinary prose passes. The git and filesystem safety checks did not change.

