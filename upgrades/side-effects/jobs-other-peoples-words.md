# Side effects: jobs told about other people's words

**Over-block:** none. It adds a line to a prompt and refuses nothing.
**Under-block:** this is a soft protection. A job can still read and be steered by logged words; the limit stays disclosed.
**Level:** a prompt line, because job sessions read log files directly and no route check could close this.
**Signal vs authority:** signal only. It holds no blocking authority.
**Interactions:** prepended before the job's own prompt, like the existing blocks, so skill jobs keep their slash command last.
**Rollback:** remove the wiring line in `server.ts`; the check is then null and no line is added.
