import { randomUUID } from "node:crypto";

import type { OrgClient, OrgSessionView } from "@marshal/agent-runtime-org";

import type { SdkSessionState } from "../../common/sdk-hosts-contract";
import type { StoredSdkHost } from "./sdk-host-store";
import type { SdkHostTransport } from "./sdk-host-transport";
import {
  SdkLinkError,
  type LinkInfo,
  type LinkSessionRecord,
  type LinkTranscriptMessage,
} from "./sdk-link-client";

/** The runtime marshal-sdk's org publishing stamps on every session it publishes (marshal-sdk src/org-publish.ts). */
export const ORG_SDK_RUNTIME = "marshal-sdk";

/**
 * The organization as an SDK host: every marshal-sdk session the signed-in person can see there (their own runs and
 * the ones shared with them), read, messaged and continued through the org API with their own sign-in.
 */
export const ORG_SDK_HOST: StoredSdkHost = {
  id: "org",
  name: "Organization",
  url: "org:",
  token: "",
  addedAt: "",
};

export type OrgSdkClient = Pick<
  OrgClient,
  | "supports"
  | "listSessions"
  | "getSession"
  | "getTranscript"
  | "postMessage"
  | "forkSession"
  | "getForkEnvelope"
  | "getCloudCapabilities"
>;

const LIST_PAGE = 100;
const MAX_LIST_PAGES = 5;
const TRANSCRIPT_PAGE = 200;
/** "<title> · run <8 hex> on <host id>": how org publishing names a session. */
const PUBLISHED_TITLE = /^(.*) · run ([0-9a-zA-Z-]{1,8}) on ([^\s]+)$/;
const RUNNING_STATES: ReadonlySet<string> = new Set(["running", "queued", "hot"]);

function state(view: OrgSessionView): SdkSessionState {
  if (view.turnState === "failed") return "failed";
  return view.turnState && RUNNING_STATES.has(view.turnState) ? "running" : "idle";
}

function toRecord(view: OrgSessionView): LinkSessionRecord {
  const { session } = view;
  const named = PUBLISHED_TITLE.exec(session.title);
  return {
    id: session.id,
    title: named?.[1] || session.title,
    state: state(view),
    createdAt: session.createdAt,
    updatedAt: view.lastActivityAt ?? session.updatedAt,
    runId: named?.[2] ?? "",
    labels: {
      owner: session.owner.replace(/^user:/, ""),
      ...(named?.[3] ? { host: named[3] } : {}),
    },
    messageCount: session.transcript.messageCount,
    costUsd: 0,
  };
}

async function collect(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new SdkLinkError("too-large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Reaches marshal-sdk sessions published to the organization (org bridge): list, search, transcript, send through
 * the session inbox (the host holding the lease runs it), and the native conversation through a fork's envelope.
 * Stop, telemetry and files have no org verb, so they answer `unavailable`.
 */
export function createOrgSdkTransport(deps: {
  getClient: () => Promise<OrgSdkClient | null>;
  /** Org sessions another host already lists (a host room shows them with its own records). */
  skipOrgSessionIds?: () => ReadonlySet<string>;
}): SdkHostTransport {
  const client = async (): Promise<OrgSdkClient> => {
    let found: OrgSdkClient | null;
    try {
      found = await deps.getClient();
    } catch {
      throw new SdkLinkError("unreachable");
    }
    if (!found) throw new SdkLinkError("unauthorized");
    if (!found.supports("sessions")) throw new SdkLinkError("unavailable");
    return found;
  };

  const views = async (): Promise<OrgSessionView[]> => {
    const org = await client();
    const found: OrgSessionView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
      const result = await org.listSessions({ limit: LIST_PAGE, cursor });
      const skip = deps.skipOrgSessionIds?.();
      found.push(
        ...result.sessions.filter(
          (view) => view.session.runtime === ORG_SDK_RUNTIME && !skip?.has(view.session.id),
        ),
      );
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return found;
  };

  return {
    async info(): Promise<LinkInfo> {
      const listed = await views();
      return {
        protocol: 1,
        host: { id: ORG_SDK_HOST.id, kind: "org" },
        mode: "live",
        runs: new Set(listed.map((view) => toRecord(view).runId)).size,
        sessions: listed.length,
        extensions: [],
        files: [],
      };
    },

    async sessions() {
      return (await views()).map(toRecord);
    },

    async search(query, limit) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      return (await views())
        .map(toRecord)
        .filter((record) => {
          const text = `${record.title} ${Object.values(record.labels).join(" ")}`.toLowerCase();
          return words.every((word) => text.includes(word));
        })
        .slice(0, limit)
        .map((session) => ({ session, snippet: session.title, score: 1 }));
    },

    async transcript(sessionId, options) {
      const org = await client();
      const view = await org.getSession(sessionId);
      if (view.session.runtime !== ORG_SDK_RUNTIME) throw new SdkLinkError("not-found");
      const total = view.session.transcript.messageCount;
      const start = Math.max(0, total - Math.max(1, options.tail));
      const messages: LinkTranscriptMessage[] = [];
      let cursor: string | undefined = String(start);
      while (cursor !== undefined && messages.length < options.tail) {
        // eslint-disable-next-line no-await-in-loop -- cursor paging is sequential
        const page = await org.getTranscript(sessionId, { cursor, limit: TRANSCRIPT_PAGE });
        if (page.messages.length === 0) break;
        for (const message of page.messages) {
          const index = start + messages.length;
          messages.push({
            index,
            id: `${sessionId}:${index}`,
            role: message.role === "assistant" || message.role === "system" ? message.role : "user",
            content: message.text,
            timestamp: message.at,
          });
        }
        cursor = page.nextCursor;
      }
      return { session: toRecord(view), total, cursor: start + messages.length, messages };
    },

    async send(sessionId, message) {
      const org = await client();
      if (!org.supports("messages")) throw new SdkLinkError("store-only");
      await org.postMessage(sessionId, { clientMsgId: randomUUID(), text: message }, "desktop");
    },

    async native(sessionId) {
      const org = await client();
      if (!org.supports("forks")) throw new SdkLinkError("no-native-state");
      const caps = await org.getCloudCapabilities();
      const forked = await org.forkSession(sessionId, {
        clientForkId: `sdk-continue-${randomUUID()}`,
      });
      if (!forked.envelope) throw new SdkLinkError("no-native-state");
      const download = await org.getForkEnvelope(forked.session.id, {
        maxBytes: caps.maxEnvelopeBytes,
      });
      if (download.envelope.format !== "claude-jsonl") throw new SdkLinkError("protocol");
      const gzipped = await collect(download.body, caps.maxEnvelopeBytes);
      return {
        title: toRecord({ session: forked.session, role: "owner" }).title,
        nativeSessionId: forked.session.id,
        state: {
          format: "claude-jsonl",
          encoding: "gzip-base64",
          data: gzipped.toString("base64"),
        },
      };
    },

    telemetry: () => Promise.reject(new SdkLinkError("unavailable")),
    files: () => Promise.reject(new SdkLinkError("unavailable")),
    readFile: () => Promise.reject(new SdkLinkError("unavailable")),
    cancel: () => Promise.reject(new SdkLinkError("unavailable")),
  };
}
