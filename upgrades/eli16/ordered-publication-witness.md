# Keep important changes in order when Echo moves between machines

Needs-you and app message handover need a clear answer about which machine was allowed to act and whether that exact action already happened. A replacement machine may be ready to work while an old copy is still catching up. A message may also arrive twice after a retry, or a backup may bring back a copy of the journal from before a handover.

This source checkpoint gives the receiving code a way to verify a signed record from a separate witness. The record identifies the agent, the part of the product, the exact action and its contents, and the last accepted point in the journal. A machine cannot witness its own action. Changing witnesses takes signatures from both the outgoing and incoming witness for that same point. The receiver checks the independent journal position before it records a local receipt. If the witness is unreachable or a restored copy is too far behind, the receiver waits for reconciliation.

The setting starts off. This checkpoint has no live connection to the Needs-you list or app message sending. It records local evidence and gives the next checkpoint a source interface to build on. Live action still needs a verified authority connection and a current-generation check at the point where the action takes effect.

A holder change now also has a local completion step. The receiver stays paused until the independent journal confirms the exact move, including the sealed predecessor. It updates the local holder and journal position together so a restart sees either the pending move or the completed move.

The predecessor proof also needs the old journal itself. The verifier checks every record in order against the seal, so a delayed last record or a rewritten row cannot pass as a complete journal. A verified prefix is one input to resolving an earlier attempt whose outcome is still unknown.

If the old machine lost the reply to an append, the new machine keeps that attempt outstanding. It can recognize a confirmed append only when the authenticated reconciliation names the current handover and the exact attempt, and the sealed journal contains those exact bytes.
