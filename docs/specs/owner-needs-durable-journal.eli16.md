# Confirm decisions only after they are saved

Needs You needs a way to save an owner's decision before telling them it went through. This change builds the private journal operation for that job. It checks that the server still holds the expected lease just before writing the decision and confirms success only after the exact record has been synced to disk.

If the server loses its lease or stops during the write, the next process keeps the decision on hold. If a complete journal read can identify the exact decision and the local bytes can be synced, the writer can confirm it without writing it again. If evidence is incomplete, the writer keeps the decision on hold. The new operation is still disconnected from the live Needs You screen. Direct peer reads and writer-lock replacement need to honor the same fence before activation.
