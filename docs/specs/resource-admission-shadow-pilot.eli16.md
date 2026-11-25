# Checking whether the session limit is getting in the way

A machine can have many open sessions and still have room to start more work. It can also run short of memory with only a few sessions. Before changing the limit, this pilot compares what the current count says with what the machine's memory, swap and CPU readings say.

The comparison runs beside the existing start decision. It cannot start extra work, pause a session or move it to another computer. If a reading is missing or the expected cost of a start is unknown, the report says there is not enough evidence to make the comparison.

The report shows where the two decisions differ and whether a real launch was observed. If the current count refused a start, the report cannot claim that the start would have worked. A controlled test is needed to prove it before changing the live policy.
