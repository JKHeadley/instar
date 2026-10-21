# Telegram Notice Spam and Duplicate System Topics — Plain-English Overview

## The problems

Justin reported two things in Telegram. First, topics he had not touched in a while kept getting the line "I have your message; my reply is delayed while it is routed through Mac Studio". Second, new topics called Updates, Attention and Agent Health kept appearing, many of them empty.

## Why the notices happened

Echo runs on several machines, and only one (the Mac Studio) is allowed to send Telegram messages. When another machine (the Mac Mini) tries to send and cannot pass the message on, it holds the message and sends that "I have your message" line so the person is not left wondering. But the line was sent for every held message, including background ones nobody asked for: job results, status lines, restart notices. On the Mac Mini, every one of the 231 held messages was background output. So the line was false every time, and it came in bursts.

## The fix for the notices

The line is now sent only when the held message is a session's reply, which the sealed message record says. Even then, a topic is told only once every 6 hours, however many replies are held. Background output never triggers it. The held message itself is still kept, retried and reported exactly as before; only the extra line changes.

## Why the duplicate topics happened

A machine that is not in charge is not allowed to save anything, so it cannot fork the shared state. The machine called Mama PC had never saved an Updates topic. On every restart (and it restarts after every update) it created a new Updates topic, could not save which one it made, and made another one next time. It had made 41.

## The fix for the topics

Only the machine in charge may create one of these three topics. The other machines ask the machine in charge which topics it uses (a new read-only address, `/telegram/system-topics`) and save those ids. That one kind of write is allowed on a machine that is not in charge, for those three ids only, because copying the in-charge machine's choice cannot split anything. The Agent Health topic id is now saved too, so it survives restarts.

## What stays the same, and what to decide

Held replies, their retries and their expiry reports are unchanged. The topics that already exist stay. The empty duplicate topics can be deleted; that is a separate action, and Justin decides it.
