# Keep an uncertain decision out of journal replies

If the server stops while saving a Needs You decision, the journal keeps a local note that says the save needs to be checked. A second machine can ask for recent journal entries directly. That request now checks the same local note before it reads and again before it replies. If a save is still uncertain, the request reports that it cannot serve the stream yet.

The local summary reader also skips the uncertain entry. It can still show older entries, while the complete decision reader reports that its view is incomplete. The recovery path can read the exact local entry and sync it again if the complete record agrees. This is part of the dark writer work. The live screen still cannot use the new writer, and a separate check is needed to guarantee the old process cannot write after its lock is taken over.
