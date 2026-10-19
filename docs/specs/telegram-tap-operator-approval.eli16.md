# Plain-English overview: approving feedback gates with one tap

## What this is

Two decisions in the feedback system belong to the operator and stay his. The first is which
model sorts incoming feedback reports. The second is a one-time OK that lets the fix worker run
even though this agent could approve its own fixes on GitHub. Today both need him to open the
dashboard, find the right card, and type his PIN. He has to type the same PIN to open the
dashboard in the first place, so the second PIN entry feels pointless.

This spec makes two changes.

**Part B, first: no second PIN.** When the operator opens the dashboard with his PIN, the
dashboard remembers that for a short while. One gate (signing a subscription back in) already
accepts that recent unlock in place of typing the PIN again. This extends the same rule to the two
feedback gates. Approving becomes one press on the dashboard. Nothing gets weaker: the remembered
unlock was itself made with his PIN, and the agent's own access key cannot create one.

**Part A, next: approve from Telegram.** When one of these decisions is waiting, the agent posts
one message where he already works. It says what is being decided in one sentence and has two
buttons, Approve and Not now. He taps Approve and it is done. The bot then says "Approved by your
tap at 22:41" with an Undo button.

## The hard question, answered

The agent can send messages through the operator's own Telegram account, using a browser that is
logged in as him. So could it press the Approve button itself and pretend to be him?

The honest answer has two parts. The PIN is not truly out of the agent's reach either. It sits in
a file on the agent's own computer, and only a standing rule stops the agent using it. A tap is
accepted only when the agent's one known route into his Telegram (the "browser broker") provably
cannot press buttons. The broker has no button-pressing operation, and a test fails the build if
one is ever added. A tap is also refused if that broker used his account in the last two minutes.

The tap must also come from his Telegram id and through the secret-protected path from the
Telegram listener. It works once, for one specific decision, and expires after 15 minutes. If no
owner is configured, every tap is refused. Under those conditions a tap is as strong as the PIN,
and in some ways stronger, because the PIN is not tied to any one decision. It is never treated
as proof that a human pressed it, and neither is the PIN. Every tap is announced with an Undo
button, so a tap he did not make shows up immediately and can be reversed.

## What already exists vs. what's new

These already exist: the secret-protected path that carries Telegram taps into the server, a
pairing-invite button flow with exactly the owner checks this needs, the "recent dashboard unlock"
check used by subscription sign-in, and the broker with its limited operations. New in this spec:
one shared "what can satisfy an operator approval" check, the two-button message, the broker
quiet-window check, and tests that pin the broker's operation list and the list of gates allowed
to use taps.

## What this does not change

No other PIN-protected control gets taps. The dashboard PIN path keeps working exactly as it does
today. Revoking stays one press, as it is now.

## Found along the way

The existing Telegram approval for the backup tunnel relay accepts a tap from anyone when no owner
is configured. That is filed for its own fix.

## What you need to decide

Nothing beyond the normal review. Both parts ship switched off for the fleet, and each can be
turned back off with one setting.
