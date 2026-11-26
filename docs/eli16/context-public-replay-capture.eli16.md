# Capture Answers for the Public Context Replay

This manual experiment compares how a model answers the same public examples with no optional context, abbreviated context, and full context. Each group uses the same example, fixed clock and question. The procedure keeps the proposed reference answers outside the capture command.

The capture accepts only the public fixture and example instructions in the checkout. It checks the planned input before opening a fresh Claude process. Before sending a scenario it asks the configured route to demonstrate that tools are unavailable. The process starts with an empty tool list, an empty MCP configuration and hooks disabled.

The result is a private local file with captured answers and reported usage. When an answer cannot be graded, the file says whether it was not valid JSON or was JSON of the wrong shape, using only the validator's short reason and never the answer text. Run a complete planned grid for grading. A small pilot can verify the route and output format. Neither use qualifies a model for production.
