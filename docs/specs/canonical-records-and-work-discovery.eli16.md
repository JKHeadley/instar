# Find the work Instar already did

Justin asked about permanent addresses for Instar agents. A previous conversation had already settled part of the design, and a pull request contained the implementation. Instar checked a small memory index, missed the design, and started considering the same work again. It also has two ways to make a project appear on a list, so asking which projects exist can give different answers.

This proposal changes both paths. Each kind of record has an accountable owner inside Instar. That owner is where changes go. A report can show a project's latest state and add its own check-in history, with a link back to the project record. Two screens can show different subsets and explain their inclusion rules.

One lookup connects earlier conversations, decisions, projects, tasks, documents, and pull requests. It shows what it found and which sources it could search. If a machine went offline or a search finished only partway, the answer can give the useful evidence and say where the gaps are. Each source keeps its own access rules.

Before a supported workflow opens durable work, it records the lookup and what it decided to do with the result. An agent can continue an existing effort, link a related one, or explain what makes a new effort distinct. Repeating the exact same request should return the same work item. Two similar ideas can still become separate projects.

The first full test will replay the permanent-links question with incomplete conversation history. The answer should surface the existing pull request and distinguish what was approved, implemented, and deployed. A later specification applies the same rules to projects and scheduled jobs, including what happens if an update stops halfway through.
