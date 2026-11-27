# Each health problem names its machine — plain-English overview

**What this is.** When an agent runs on several computers (Echo runs on a Mac Studio, a Mac mini, a laptop and more), the phone's "Needs you" list and the dashboard's Health page show problems like "iMessage isn't connected". The fix text says "someone at this Mac allows my program in System Settings", but nothing said which Mac. The operator asked for that on 2026-11-06.

**What already exists.** The health reading is built on the machine the phone or browser happened to reach: that machine reads its own /health and sorts each reason into plain words. So every problem in one reading really is that machine's own problem. The machines list (GET /mobile/machines) already names each machine from the pool's nickname, with a stable one-way key per machine.

**What is new.** The reading now adds `machine: { key, name }` to the answer and to each problem. The name comes from the same verified pool nickname the machines list uses. With no pool, it uses the computer's own name. The key is the same key the machines list uses, so an app can match the two. The dashboard prints "On Mac Studio" under each problem's title and in Home's health row. The phone app shows the same words in its problem sheet.

**Safeguards.** It is a read-only, additive field. Nothing is blocked, decided or stored. If the machine can't be named, or the lookup throws, the field is left out and the reading answers exactly as before. The name passes through the shared name check that refuses ids and placeholders, so a raw machine id never shows as a name. Older apps ignore the field.

**What you need to decide.** Nothing. This is a small, reversible display change. A revert removes the field and the words.
