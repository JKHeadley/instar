# Jobs that were refused on every run — Plain-English Overview

## The problem

Some scheduled jobs have a quick pre-flight check, called a gate. Because a gate can take a few seconds, the scheduler looks at the job again afterwards, to make sure nobody changed it in the meantime. That safety check arrived with the job-transfer work on Nov 5.

There is a second thing going on. Some jobs are written as scripts but are currently set to run as full sessions instead. The scheduler handles that by making a temporary copy of the job marked "run as a session". The safety check compared the real job against that temporary copy. They always differ, so the check decided the job had changed, every single time, and refused to run it.

The feedback factory, the pipeline that turns reports into fixes, is made of jobs like this. It stopped at 16:00 UTC on Nov 5 and never recovered. Every fix filed since has been waiting behind it. The refusal was also written down as "disabled" and as a file-integrity failure, so anyone reading the record saw the wrong cause.

## What changes

The scheduler now remembers the job as it was before making the temporary copy, and compares against that. A job that nobody touched runs. A job that really was edited during its gate is still refused.

Each kind of refusal now says what it is: changed, disabled, removed, or a real integrity failure. The integrity record is only written when the integrity check actually failed. A job refused for being changed, three times in a row, now raises the same "this job has gone quiet" alert as other silent jobs, so a repeat of this could not stay hidden for 19 hours.

## What stays the same

Real edits, switching a job off, deleting it, and tampering with an imported job's approved files all still stop the run. The jobs resume on their normal schedules, under the usual usage and memory limits.

## What was checked and left alone

One report suspected that gates were using a wrong login token. They are not. The failures near server starts are the server still starting up. The rest are gates correctly saying there is nothing to do.
