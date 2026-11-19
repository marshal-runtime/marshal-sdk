# agent-sandbox's marshal-sdk.json

The host agent-sandbox's page agent runs on: Page Studio 0.2.0 pinned by sha256 from the dev bucket, its Decisions key
from `OPENAI_API_KEY`, ZyG's Brain signed in as the service (the sandbox's e2b-production key: `service-key` mode), memory and
published sessions on, Opus 5.5 at xhigh. The Brain answers for the person `$MARSHAL_BRAIN_PERSON` names, unless a run
passes its own (`ClaudeAgentOptions(user=<email>)`); with neither, runs go on without the Brain and say so once.
agent-sandbox calls `marshal_sdk.init("marshal-sdk.json")` at start. Prove it on a machine with the service's credentials:

```sh
OPENAI_API_KEY=… npx marshal-sdk check --manifest examples/zyg-agent-sandbox/marshal-sdk.json --person someone@zyg.com
```
