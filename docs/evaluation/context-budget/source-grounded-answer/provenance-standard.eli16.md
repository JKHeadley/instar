# What the Source Provenance Standard Changes

This document explains how an evaluation should keep track of where its evidence came from. An answer can quote a file perfectly and still draw the wrong conclusion. The file might not identify its real author, its approval might apply to a different project, or a missing earlier message might explain what the approval meant. Checking that a file has not changed cannot settle those questions.

The proposed standard asks the host that holds the source to keep those questions separate. It records the original bytes, how the source was captured, what is known about the speaker, what authority the statement carries, when it applied, what context is missing, and which machine holds the evidence. A signature or digest receives only the credit it actually supports. Missing evidence stays visible rather than turning into an assumed success.

This is public design guidance with invented examples. It does not add a running verifier, send information to another service, read evaluation cases, or change which actions an agent can take. It allows locally held authentication evidence and does not require an outside service. The answer model receives only the evidence it is allowed to see; the host keeps its own verification record separate from the model's claims.

The reviewer should decide whether these distinctions are clear enough to guide a later implementation and whether the examples avoid claiming more certainty than their evidence supports. A revert removes the entire change because it creates no data migration or runtime behavior. The concrete acceptance check is an independent reading of the document, a whitespace check, and the repository's installed commit gates. No private evaluation results are claimed.
