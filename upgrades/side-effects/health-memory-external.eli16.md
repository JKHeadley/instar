# Showing the memory a server holds outside its main working memory

The agent's server reports its memory use on its health check: the total it occupies, and how much of that is its JavaScript working memory (the "heap"). On the Mac Studio the total is about 3 GB, but the heap is only about 1 GB. So roughly 2 GB is somewhere else, and nothing showed where.

Node.js already knows two more numbers: memory held by native code (such as the databases the server keeps open) and memory held by raw data buffers. This change adds those two numbers to the health check, next to the existing ones.

That lets the memory investigation read where the extra 2 GB is, one line a minute, without attaching a profiler to the live server. Attaching one is not allowed, because it crashed the server once.

What needs deciding: nothing. It only adds two read-only numbers to an existing report.
