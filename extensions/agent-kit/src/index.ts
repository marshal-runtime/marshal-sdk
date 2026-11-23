/** The kit's interfaces: Sandbox and Channel, the two places a host binds an extension. */
export * from "./contracts.js";
/** The bound extensions as an engine uses them (the Agent SDK options of a sandboxed session, the outbox's send). */
export * from "./bindings.js";

/** Marley's one outbox: material, moments, holds, the fallback and the send (outbox/outbox.ts). */
export * as outbox from "./marley/outbox/outbox.js";
/** The outbox's SQLite tables (outbox/store.ts). */
export * as outboxStore from "./marley/outbox/store.js";
/** The composer contract, its prompt and its decision checks (outbox/composer.ts). */
export * as composer from "./marley/outbox/composer.js";
/** The composer run as a structured session (outbox/sandbox-composer.ts). */
export * as sandboxComposer from "./marley/outbox/sandbox-composer.js";
/** The one-call Vertex composer and the fallback pair (outbox/vertex-composer.ts). */
export * as vertexComposer from "./marley/outbox/vertex-composer.js";
/** The machinery screen (outbox/screen.ts). */
export * as screen from "./marley/outbox/screen.js";

/** One role session and its record (engine/run-role.ts). */
export * as runRole from "./marley/engine/run-role.js";
/** Roles (engine/roles.ts). */
export * as roles from "./marley/engine/roles.js";

/** The persona and its voice rules (persona.ts, voice-reply.ts, speaker-prompt.ts). */
export * as persona from "./marley/persona.js";
export * as voiceReply from "./marley/voice-reply.js";
export * as speakerPrompt from "./marley/speaker-prompt.js";
/** The soul every turn reads (prompt-v2.ts). */
export * as soul from "./marley/prompt-v2.js";

/** Routine run events (routines/events.ts). */
export * as routineEvents from "./marley/routines/events.js";

/** The Slack channel binding (the `@marshal/agent-kit-slack` extension's service). */
export * as slackChannel from "./channels/slack.js";
