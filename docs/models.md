# Model services: decide, embed, speech

Every SDK host has native model services alongside its chat agent. They are part of the SDK itself, not extensions:

| Service | What it does | Providers (default first) |
| --- | --- | --- |
| decide | Answers a question from a context: picks one of the options (with probabilities), answers yes/no, or fills a JSON schema | `jev`, `openai` |
| embed | Turns texts into L2-normalized vectors (`document` or `query` task) | `gemini`, `local` |
| speech | Synthesizes text as a mono Ogg Opus voice note, and transcribes audio | `google` (Chirp 3 STT, Gemini TTS), `elevenlabs` (scribe_v2, eleven_v3) |

You can reach them in two ways:

- **In code:** through `host.models.decide`, `host.models.embed`, `host.models.speech()` and `host.models.describe()`. To use them without a host, call `createModelServices(config)` from `@marshal/sdk`.
- **As runtime capabilities** that sessions, extensions and TypeScript blocks call:
  - `marshal.models.decide`
  - `marshal.models.embed`
  - `marshal.models.speak`
  - `marshal.models.transcribe`

  A failure comes back as `{success: false, error, code}`; it is not thrown.

```ts
const host = await createMarshalHost({ workspacePath, models: { embed: { provider: "local" } } });
await host.models.decide.decide({ question: "Ship today?", options: ["ship", "wait"], context: { ci: "green" } });
// { choice: "ship", confidence: 0.8, probabilities: { ship: 0.8, wait: 0.2 }, provider: "jev", ... }
await host.invoke("marshal.models.embed", { texts: ["refund policy"], task: "query" });
```

## Configuration (`models` in marshal-sdk.json)

```json
{
  "models": {
    "decide": { "provider": "jev", "model": "gpt-5-mini" },
    "embed": { "provider": "gemini", "dimensions": 1536, "project": "zyg-ecom-zygstinct" },
    "speech": { "ttsProvider": "google", "sttProvider": "elevenlabs" }
  }
}
```

The same object can be passed as `createMarshalHost({ models })`; an explicit option wins over the manifest.

- **decide:**
  - `provider` is `jev` or `openai`.
  - `model` defaults to `gpt-5-mini`.
  - `reasoningEffort` is optional.
  - `baseUrl` points at any OpenAI-compatible endpoint; default `https://api.openai.com`.
  - `keyEnv` defaults to `OPENAI_API_KEY`.
  - `jev` runs Jev's judgement contract and returns a full, validated probability distribution. With options it asks a `choice` question; without options it asks a `noul` (yes/no) question. Pass `questions` + `state` to `marshal.models.decide` (or call `decide.judge`) to ask several named choice / score / yes-no questions at once.
  - `openai` makes one structured-output call and returns `{choice, confidence, reasoning}`.
  - Both providers handle `schema` the same way: the answer object is returned as `choice`.
- **embed:**
  - `provider` is `gemini` or `local`.
  - `model` defaults to `gemini-embedding-2`.
  - `dimensions` defaults to 1536.
  - With `GEMINI_API_KEY` (the variable named by `keyEnv`) set, calls go to the public Gemini API. Without it, calls go to Vertex AI with an ADC bearer token, using `project` (or `GOOGLE_CLOUD_PROJECT`) and `location` (default `global`).
  - `concurrency` defaults to 8.
  - Texts get the same task wording as Zygstinct's embedding proxy, so vectors match the ones it stores.
  - `local` runs the on-device mxbai-embed-xsmall model through `@quillstone/embedding-runtime`. That package and its transformers.js / onnxruntime peers must be installed next to the SDK; without them the call fails with code `not-installed`. Options for it go in `local`.
- **speech:** Marley's speech settings (`ttsProvider`, `sttProvider`, `google: {...}`, `elevenlabs: {...}`, limits). Any field left unset is read from the same `SPEECH_*` / `ELEVENLABS_*` variables Marley reads (`speechConfigFromEnv`). The speech service is built on first use, so a host that never speaks pays nothing.

## Credentials

Keys are read from the host's environment (`createMarshalHost({ env })`, else `process.env`) by `modelCredential(name)`. It reads `NAME` first, then the file named by `NAME_FILE` (for mounted secrets). The keys:

| Key | Used by |
| --- | --- |
| `OPENAI_API_KEY` | decide |
| `GEMINI_API_KEY` | embed with an API key |
| `ELEVENLABS_API_KEY` | ElevenLabs speech |

Google calls (Vertex embeddings, Google speech) need a token. `googleAccessTokenProvider` tries these sources in order and caches the token for 50 minutes:

1. `GOOGLE_ACCESS_TOKEN` (or its `_FILE`).
2. `google-auth-library`, when it is installed.
3. `gcloud auth application-default print-access-token`.

`modelCredential` reads through the SDK's shared resolver (`readSecret` in `src/credentials.ts`, docs/providers.md), so model keys and agent-provider keys follow one rule.

## Where the code came from

- `src/models/jev/` comes from `@marshal/jev` (`marshal/extensions/jev-runtime-extension/src`, commit 73985cd): the api types, errors, OpenAI chat request and parsing, retrying transport, and answer validation. The UI and connection card were not lifted. The extension itself is unchanged.
- `src/models/speech/` comes from Marley's `packages/speech/src` (zygstinct 940a0c6d5), copied verbatim with one change: `google-auth-library` is no longer a hard dependency. Tokens come from `googleAccessTokenProvider`.
- `src/models/embed.ts` reimplements the model, task wording, dimensions, normalization and 8 KB limit of zygstinct `apps/embedding-proxy/src/core.ts`. It talks to Gemini directly rather than through the proxy.

## Not here yet

- Jev on TypeSafe's native API: both providers use OpenAI-compatible chat completions, as the extension does today.
- Video and images.
