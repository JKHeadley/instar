# Opening a new agent-to-agent thread actually opens one (ELI16)

## What was wrong

When I talk to another agent over Threadline, each conversation lives on a "thread" with an id. Normally, if I send a message to an agent without naming a thread, I continue my existing conversation with them. That is the right default.

Sometimes I want a second, separate conversation with the same agent, for an unrelated piece of work, so the two do not mix. The send route already accepted a request for that (`fork: true` or `newThread: true`), and the part of the code that decides the thread did the right thing: it made a brand-new thread id. But when the message was handed to the relay connection, the route passed along the thread the caller had given, which was none. The relay connection then did what it does when no thread is named: it reused the thread it already had with that agent. So the message went out on the old conversation, and the reply to me still said "success". On 2026-10-25 three attempts to open a new thread with the agent PP all landed on the existing thread.

## What changes

- The route now hands the relay connection the thread it actually decided. A request for a new thread goes out on a new thread, every time; two such requests make two different threads.
- Asking for a new thread AND naming an existing thread in the same request is refused with a clear error, because it cannot do both.
- If a new thread was asked for and the message still went out on another thread, the route reports a failure naming the thread it went on, instead of success.
- The `threadline_send` tool gets a `newThread` option, so an agent has a plain, supported way to open a second thread with a peer.
- My CLAUDE.md (and existing agents' CLAUDE.md, through the update migration) gains a short note saying how to do this.

## What stays the same

An ordinary send with no thread and no new-thread request behaves exactly as before: it continues the existing conversation. Sends on a named thread are unchanged. Messages to agents on the same machine already used the right thread and are unchanged.

## What to decide

Nothing. This is a bug fix with no new setting. If it turns out wrong, reverting it restores the old behaviour with no cleanup.
