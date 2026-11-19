# agent-sandbox's marshal-sdk.json

The host agent-sandbox's page agent runs on: Page Studio 0.2.0 pinned by sha256 from the dev bucket, its Decisions key
from `OPENAI_API_KEY`, ZyG's Brain signed in as the service with each run's requester as the person, memory and
published sessions on, Opus 5.5 at xhigh. agent-sandbox calls `marshal_sdk.init("marshal-sdk.json")` at start and passes
`ClaudeAgentOptions(user=<requester email>)` per run. Prove it on a machine with the service's credentials:

```sh
OPENAI_API_KEY=… npx marshal-sdk check --manifest examples/zyg-agent-sandbox/marshal-sdk.json --person someone@zyg.com
```
