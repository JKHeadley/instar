# Offline replay runner decision audit

This audit covers the existing replay runner at the benchmark candidate head. It reads explicit local input files and writes results to caller-supplied paths. Imported actions are interpreted as bounded data. They can read the provided fixture or supply a final answer. Unsupported actions are counted by refusal code without copying their arguments.

The fixed paired grid, canonical hashes, answer schema, and complete transcript checks reject mixed or incomplete trial data. Scoring stops on malformed inputs. Results are descriptive and carry no authority to qualify a model, admit production evidence, or change context shortening. There is no live hook, migration, default setting, network request, model execution, or code execution from imported answers. The runner and its output can be removed independently of live session state. This follow-up adds review evidence and leaves benchmark behavior intact.
