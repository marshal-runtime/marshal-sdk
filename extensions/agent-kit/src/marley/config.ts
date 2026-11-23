// Extract of zygstinct apps/agent-server/src/config.ts at 7110e58c8: only ServerConfig.
import * as path from "node:path";
import { type ConnectOffers } from "./connect-ladder.js";
import { type CodeLayerPin } from "./sandbox/daytona/code-layer.js";
import { type VertexConfig } from "./vertex.js";

/** A sandbox VM the server can reach, keyed by host id (agent_hosts.id). */
export interface SandboxHostEntry {
  instance: string;
  zone: string;
}

/** Everything the agent server needs at runtime. Env vars win over the config file. */
export interface ServerConfig {
  serverName: string;
  project: string;
  root: string;
  stateDir: string;
  gatewayUrl: string;
  /** BRAND_REPO_KEY_SECRET_PREFIX: the Secret Manager prefix of brands' GitHub deploy keys (default production's `zs-brand-repo-key-`; staging names its own, as its provisioner does). */
  brandRepoKeySecretPrefix: string;
  /** META_ACTIONS_ENABLED=true: owners may approve Meta changes Marley proposes in their DM. */
  metaActionsEnabled: boolean;
  /** WORKSPACE_ACTIONS_ENABLED=true: owners may approve Google Workspace writes (mail, Docs, calendar) that Marley proposes in their DM. */
  workspaceActionsEnabled: boolean;
  /** WORKSPACE_ACTIONS_BRANDS: the only brands whose owners may use Google Workspace actions, whatever the switch says. Canonical lower-case UUIDs, comma separated; empty or malformed means none. */
  workspaceActionsBrands: ReadonlySet<string>;
  /** BRAIN_WORKER_BRANDS: the brands whose graph the always-on brain worker writes to Spanner while their sandbox is stopped (docs/design/brain-worker.md). Canonical lower-case UUIDs, comma separated; empty or malformed means none (default off). */
  brainWorkerBrands: ReadonlySet<string>;
  /** BRAIN_RUNTIME_ROOT: where the image installed the corpus engine packages for the brain worker (default /opt/zygstinct/brain-runtime). */
  brainRuntimeRoot: string;
  /** Every brand: everything a session says goes to the one outbox (docs/design/organism-outbox.md), and the outbox agent decides what reaches the person. No setting turns it off. */
  organismOutboxBrands: ReadonlySet<string>;
  /**
   * ORGANISM_FIRST_CONTACT_BRANDS: the brands whose signup owner's first reply is first contact (first-contact.ts): one finding of the first-look record with
   * its figure and one question, no voice, the onboarding lines folded into the one message. Local and test brands only; production stays Omer's decision
   * (PI09/D53). Canonical lower-case UUIDs, comma separated; empty or malformed means none (default off).
   */
  organismFirstContactBrands: ReadonlySet<string>;
  /** ORGANISM_DECIDE_BRANDS: the brands whose people's messages are decided first into answer, hold_and_check, join_task or from_task before the front runs (decide-first.ts). Canonical lower-case UUIDs, comma separated; empty or malformed means none (default off). */
  organismDecideBrands: ReadonlySet<string>;
  /** ORGANISM_DECIDE_TIMEOUT_MS: how long decide-first waits for the decider's sandbox run before the fallback hold (decide-first.ts DECIDE_TIMEOUT_MS when unset). Read only for a brand on ORGANISM_DECIDE_BRANDS. */
  organismDecideTimeoutMs: number | undefined;
  /** ORGANISM_DATA_CARDS_BRANDS: the brands whose front and worker prompts carry the product-cost card and the data-event text, and whose pixel-walk workers carry the walk card (src/cards). Same format; default off. */
  organismDataCardsBrands: ReadonlySet<string>;
  /** CONNECTOR_REQUESTS_ENABLED=true: any active member's DM may file a request for a source the site has no tile for (connector-requests.ts). */
  connectorRequestsEnabled: boolean;
  /** TEAM_INVITES_ENABLED=true: a member DM may set up a teammate's invite to forward (team-invites.ts). */
  teamInvitesEnabled: boolean;
  /**
   * PIXEL_AUDIT_DAILY: on unless exactly `false`. The pixel check has no schedule (R148, MLY-750): it runs when the brand's signup owner asks in chat
   * (`zs.pixels.check_now`) and at onboarding, as a background re-audit under the owner's consent; a complete run is offered to the owner through the proactive
   * schedule `pixel-check` as the report page, with a "Since" section and a video when something is new or fixed (pixel-watch.ts, MLY-361). An incomplete or
   * failed run sends nothing. `false` is the operator's kill switch.
   */
  pixelAuditDaily: boolean;
  /** BROWSER_RELAY_PORT: the port of the browser relay's WebSocket (browser-relay.ts), on every interface; 0 or unset: no relay. */
  browserRelayPort: number;
  /** Where Marley links a person to connect a source (WEB_URL), and which sources the web app offers (CONNECT_OFFERS). */
  connectOffers: ConnectOffers;
  /**
   * ONBOARDING_JOURNEY=true (exactly): every turn's host context carries "Where this brand is" and the connecting guide reads
   * it; the brand graph gets one connector per supported source and the onboarding milestones (journey.ts). Off by default.
   */
  onboardingJourney: boolean;
  /** TEAM_ROUTINE_ACCESS_ENABLED (default on; exactly `false` turns it off): any active member in their own direct chat gets the morning-brief voice and mapper grant and the brand's latest routine results (routines/team-results.ts). */
  teamRoutineAccess: boolean;
  /** FRONT_MODEL: the model id every brand's front conversation turn uses (the evolving agent's fast front, docs/design/evolving-agent.md). Unset or malformed gives none (the role's model). */
  frontModel: string | null;
  /**
   * ROUTINE_MODEL, for model experiments without a package edit: the chat package's routine role (over its profile and AGENT_MODEL), and every Opus
   * profile the routine engine runs (free time and its scout/unlock agents, forks, lanes and server breakers, the daily brief, onboarding, the intake
   * reveal; routine-engine.ts routineModelFor). Sonnet and Haiku profiles keep theirs. Unset: the first VERTEX_MODELS model (gemini-4-neon) when
   * Vertex is configured, otherwise none (the profiles' models); `profile` keeps the profiles' models even with Vertex (Omer R2, 2026-11-22: Neon in
   * place of Opus). Malformed gives none.
   */
  routineModel: string | null;
  /**
   * VERTEX_PROJECT and the other VERTEX_* settings (vertex.ts): Vertex AI with a hard spend cap (VERTEX_SPEND_CAP_USD, required). Null when VERTEX_PROJECT
   * is unset.
   */
  vertex: VertexConfig | null;
  /**
   * OUTBOX_COMPOSER_MODEL: the model the outbox composer writes every message with. Unset or malformed gives gemini-4-neon (Omer, 2026-11-22), which runs
   * as one Vertex call from this server (outbox/vertex-composer.ts) when `vertex` is set and lists the model; otherwise the composer is the Claude run of
   * `composerFallbackModel`. A claude-* id runs that model on the brand's sandbox as before (claude.ts compose).
   */
  composerModel: string;
  /** OUTBOX_COMPOSER_FALLBACK_MODEL: the Claude model that composes when a Gemini composer fails, runs out of its share of the budget, or was refused once. Default claude-sonnet-5-5: on Haiku it relayed its turns' notes flat (bench 2026-11-18). */
  composerFallbackModel: string;
  /** OUTBOX_COMPOSER_THINKING: a Gemini composer's thinkingLevel (`low` default; Gemini 4 Neon refuses `minimal`), or `default` for the model's own. */
  composerThinking: string | null;
  /**
   * OUTBOX_COMPOSER_HEDGE_SECONDS (default 12) and OUTBOX_COMPOSER_PRIMARY_SECONDS (default 22): a Gemini composer's first attempt that has not answered
   * after the hedge has the fallback start beside it; a valid Gemini answer still wins until the primary limit, after which the fallback's answer is the
   * moment's (FallbackComposer). On the Nov 20 moments Neon took 13/19/20/25 s at p25/50/75/90; the answer budget is 25 s (outbox.ts ANSWER_BUDGET_MS).
   */
  composerHedgeMs: number;
  composerPrimaryMs: number;
  /**
   * The composer's own session per direct chat (outbox/session-composer.ts, docs/design/composer-agent.md). OUTBOX_COMPOSER_SESSION_HEDGE_SECONDS (default 12):
   * a session turn that has not answered by then has the one-call composer start beside it, and the first valid answer is the moment's.
   * OUTBOX_COMPOSER_CONTEXT_TOKENS (default 120000): past it the session is summarized and started again at its next pass after a send (at a reply, only past
   * one and a half times it, carrying the last summary). OUTBOX_COMPOSER_REFLECT_SECONDS (default 300): the pass after a send's own budget.
   */
  composerSessionHedgeMs: number;
  composerContextTokens: number;
  composerReflectMs: number;
  /** OPENAI_API_KEY: the key of the OpenAI Decisions model behind POST /zs/decide (browser-decide.ts), which the VM's browser asks for each step; the same secret the channel gateway's reaction picker reads. Unset: /zs/decide answers unavailable and the VM's browser task stops. */
  openaiApiKey: string | null;
  /** Wall-clock budget of a front turn before it is handed off (BACKGROUND_FRONT_TURN_BUDGET_SECONDS, default 15), and the grace after it before the turn is aborted and converted (default 20). */
  frontTurnBudgetMs: number;
  frontTurnGraceMs: number;
  /** Most workers at once for one conversation (default 2), for one brand (default 3) and the front capacity kept free of workers (default 1). */
  backgroundWorkersPerConversation: number;
  backgroundWorkersPerBrand: number;
  backgroundFrontReserve: number;
  /** Bucket the gateway saves inbound media to and the server writes outbound files to. */
  attachmentsBucket: string;
  /** Marley's artifact store (ARTIFACTS_BUCKET): set, a reply's documents go to this bucket and the chat gets a link to the web app's Files page; unset, they go as WhatsApp documents. */
  artifactsBucket: string | null;
  footageBucket: string | null;
  footageJob: string;
  footageRegion: string;
  footageSecret: string;
  /** ARTIFACT_WEB_SECRET: Secret Manager name of the web app's bearer token for the artifact read route (default zs-artifact-web-token). */
  artifactWebSecret: string;
  /** ARTIFACTS_TEAM_VISIBLE (default on, "for now", owner 2026-11-05): every active member of the brand opens every file of the brand, whichever DM it went to. "false" restores DM-private files (SD16). */
  artifactsTeamVisible: boolean;
  /** SUBSCRIPTION: the Pub/Sub subscription the service pulls; "" when unset (startup refuses that unless DISABLE_PUBSUB=true). */
  subscription: string;
  concurrency: number;
  contextBudgetTokens: number;
  idleRolloverMs: number;
  /** Overrides the role file's model when set. */
  model: string | null;
  agentNames: string[];
  shutdownGraceMs: number;
  healthIntervalMs: number;
  poolRefreshMs: number;
  secrets: { pool: string; pgPassword: string; pgAppPassword: string; pgDataPassword: string; pgRlsKey: string; connectLinkKey: string; browserPairingKey: string };
  pg: { host: string | null; port: number; database: string; user: string; appUser: string; dataDatabase: string; dataUser: string; sourcesDatabase: string };
  bigQueryMaxBytes: number;
  /** Brand id to the sandbox host id that serves it, for every brand whose brain broker needs a pushed Spanner token. Empty: no token is minted or pushed. */
  brainTokenBrands: Record<string, string>;
  sandbox: {
    /** The pinned Claude Code binary on the sandbox VM. */
    claudeBin: string;
    brandsRoot: string;
    /** Secret holding the SSH private key. */
    keySecret: string;
    runnerUser: string;
    /** Log in as this user instead of the brand user (interim, until the sandbox image has the brand users). */
    fixedUser: string | null;
    connectTimeoutS: number;
    /** Fallback when agent_hosts has no row for a host id. */
    hosts: Record<string, SandboxHostEntry>;
    /** host id to fixed IP, for local development and tests. */
    ipOverrides: Record<string, string>;
    zone: string;
    cacheMs: number;
    /** Keep a conversation's Claude Code process alive this long after a turn (0 = start one per turn); default 120 s. */
    liveIdleMs: number;
    /** Most live processes at once; the least recently used is closed first. */
    liveMax: number;
    /** Recycle a process after this many turns. */
    liveMaxTurns: number;
  };
  proxy: {
    upstream: string;
  };
  backup: { bucket: string };
  /** Test-only switches. Read from the process environment only, never from config.json. */
  testing: { fakeModel: boolean };
  /**
   * Brands the team uses for internal testing: only their model sessions may use subscription pool members; every other
   * brand is served by the API-key member alone.
   */
  internalBrandIds: string[];
  /**
   * Brands whose members the inspector's test chat and Prompt lab may write as (TEST_CHAT_BRAND_IDS: brand ids, or "*" for
   * every brand). Unset, it is INTERNAL_BRAND_IDS. It decides nothing about the subscription pool.
   */
  testChatBrands: "all" | string[];
  /**
   * MLY-700: the platform maintainer the inspector acts as for operator nudges (INSPECTOR_NUDGE_MAINTAINER_EMAIL, the user's Google email, lower-cased).
   * Anyone signed in to the inspector nudges and approves as this user, on any brand in `maintainer_brands` for them. Null: nudges from the inspector are off.
   */
  inspectorNudgeMaintainer: string | null;
  /** D64: the UA routine runs silently; the frozen-brief send path of D58 stays off unless this is "true". */
  /** The daily owner report routine for every brand's signup owner; on unless OWNER_REPORTS_ENABLED is "false". */
  ownerReportsEnabled: boolean;
  /** Who runs routines: `server` (today's scheduler and routine graph) or `extensions` (SDK agent extensions from the per-brand registry). Any other value stops startup. */
  /** A directory whose subfolders are the release's agent extension packages (extensions/agents/*), published as the release versions at start. Unset: none. */
  extensionPackagesDir: string | null;
  /** Loopback HTTP endpoint for sending messages to the agent from the inspector. Off unless enabled. */
  testIngress: { enabled: boolean; host: string; port: number; tokenFile: string };
  /** Per-brand hold and state over the admin API (admin-api.ts; the provisioner's brain job reads it). Off unless ADMIN_API_ENABLED=1, so the old stack opens no listener. */
  adminApi: { enabled: boolean; host: string; port: number; audience: string; callers: string[]; maxHoldMs: number };
  /** Daytona sandboxes (every brand). The required settings are checked on first use. */
  daytona: {
    /**
     * `env` label of the sandboxes this server owns. No default: a deployed server must set it, equal to its SUBSCRIPTION's environment
     * (`runtimeEnvironment`), so staging can never adopt a production sandbox (MLY-412). Null only on a local stack.
     */
    env: string | null;
    /** Cloud SQL private IP the brand link's -R 15432 reaches. */
    cloudSqlPrivateIp: string | null;
    /** Public keys the sandbox's sshd trusts (1 to 4): the public half of `zs-sandbox-ssh`. */
    sandboxSshKeys: string[];
    /** TLS server name and CA secret of the brand Postgres; both or neither. */
    pgServerName: string | null;
    pgCaSecret: string | null;
    /** Spanner instance of the Brain policy; unset: sandboxes get no brain policy. */
    brainInstance: string | null;
    /** Snapshot every brand's sandbox runs (no per-brand override). */
    defaultSnapshot: string | null;
    /** The code layer pinned next to the snapshot (DAYTONA_CODE_LAYER, a layer object's gs:// URI); null: none. */
    codeLayer: CodeLayerPin | null;
    defaultIdleStopMinutes: number;
    /** How often running sandboxes made from another snapshot are looked for (DAYTONA_UPGRADE_SWEEP_SECONDS, default 120). */
    upgradeSweepSeconds: number;
    /** How long a sandbox may stay stale before the sweep upgrades it at the next turn boundary even while its brand is busy (DAYTONA_UPGRADE_DEADLINE_SECONDS, default 900). */
    upgradeDeadlineSeconds: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
  disablePubsub: boolean;
}

type Env = Record<string, string | undefined>;
