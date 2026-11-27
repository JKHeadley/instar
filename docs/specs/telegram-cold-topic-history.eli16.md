# Telegram history reads without freezing the server (ELI16)

## What happened

Every Telegram message the agent sees is written to one long log file, which can grow past 100 MB. On 27 November an idle Laptop kept freezing. When something asked for the recent messages of a Telegram conversation that was not already in memory, the server read that whole file in one go, split it into lines and checked every line, before it could answer anything else. Its log rotation did the same kind of whole-file read just to count lines.

## What changes

The history read now starts at the end of the file and reads backwards one megabyte at a time, stopping once it has enough messages for that conversation. Between pieces the server can answer other requests. The in-memory history per conversation now holds 1,000 messages, the amount several parts of the server ask for, so those requests no longer go to the file each time. A conversation whose session stops keeps its remembered history for a while, so restarting it does not read the file again. Both message logs now count their lines as they write them, so rotating never rereads the file. A missing log still means empty history, but any other failure to open it is now reported instead of being remembered as "no messages".

## The trade-off

A quiet conversation with fewer than 1,000 messages still makes the server read the whole file once, in pieces rather than in one block, before it is remembered. Each remembered conversation can use up to twice the memory it did before.

## What to decide

Nothing beyond reviewing the change. Reverting it restores the old behaviour.
