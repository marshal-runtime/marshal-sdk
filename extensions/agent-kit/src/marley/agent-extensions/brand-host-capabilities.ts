// Extract of zygstinct apps/agent-server/src/agent-extensions/brand-host-capabilities.ts at 7110e58c8: only createBrandHostCapabilities, STACK_DETECTED, STACK_SCAN, TICKET_FILE, BrandHostTool.
import { isMember } from "@zygstinct/shared";
import { PILLARS, type BrandStack } from "../brand-stack.js";
import type { BrandDirectory } from "../directory.js";
import type { Logger } from "../logger.js";
import { TICKET_AREAS, TICKET_KINDS, type MarleyTickets } from "../tickets.js";

export const STACK_GET = "marley.stack.get";

export const STACK_SET = "marley.stack.set";

export const STACK_ASKED = "marley.stack.asked";

export const STACK_DETECTED = "marley.stack.detected";

export const TICKET_FILE = "marley.ticket.file";

export type BrandHostTool = typeof STACK_GET | typeof STACK_SET | typeof STACK_ASKED | typeof STACK_DETECTED | typeof TICKET_FILE;

/** The routine whose run reports what the brand's website shows (the stack-scan agent of @marley/stack-scan). */
export const STACK_SCAN = "stack-scan";

const PROTOCOL_VERSION = "1.0";

const VERSION = "0.1.0";

const BRAND = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESULT = { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false };

/** The session roles a person's own answer can come through: their chat's front, or a worker their chat started (its `member` label is that DM's member). */
const ANSWER_ROLES = new Set(["front", "worker"]);

const CAPABILITIES: Record<BrandHostTool, { title: string; description: string; inputSchema: Record<string, unknown> }> = {
  [STACK_GET]: {
    title: "This brand's stack",
    description:
      "The tool this brand uses for each eCommerce pillar (store, Meta ads, Google ads, other paid ads, attribution, email/SMS, reviews, subscriptions, loyalty, support, site analytics, shipping, affiliate), from its connections, the newest scan of its website and what members said; for each tool whether Marley has a connector with data, a connector with nothing modelled yet, or none; the next pillar to ask about; connections started and not finished; tools it uses that are not connected or have no connector. Read it when a person asks what you can connect or see, before suggesting a tool, or before filing a ticket about a tool.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  [STACK_SET]: {
    title: "Record what the brand uses for a pillar",
    description:
      "Records what the person you are talking with told you, in their own direct chat, about the tool the brand uses for one pillar: pillar is one of the pillar ids, tool is the tool's name as they said it, or \"none\" when they said they use nothing for it. Only what they said: never a guess, and never from a scan or memory. A later answer for the same pillar replaces the earlier one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pillar", "tool"],
      properties: { pillar: { type: "string", enum: [...PILLARS] }, tool: { type: "string", minLength: 1, maxLength: 60 } },
    },
  },
  [STACK_ASKED]: {
    title: "Mark today's ask as raised",
    description:
      "Marks the Stack line's ask as raised with the person you are talking with, in the turn you raise it: ask is the key the line gives. The server then gives them no other ask that day, and an ask raised twice is not given to them again.",
    inputSchema: { type: "object", additionalProperties: false, required: ["ask"], properties: { ask: { type: "string", minLength: 3, maxLength: 80 } } },
  },
  [STACK_DETECTED]: {
    title: "Report the tools the site shows",
    description:
      "The stack scan's report: storeUrl is the site zs.pixels.scan read, tools the tool ids of its result's stack.tools, tags its stack.tags, stackUnread the result's own list, copied as it is (an empty list when the result has none). Only what the scan returned, never a guess. The server refuses a report with a page unread; otherwise it keeps the tools as seen on the site, unconfirmed, and replaces the brand's earlier report.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["storeUrl", "tools", "stackUnread"],
      properties: {
        storeUrl: { type: "string", minLength: 1, maxLength: 200 },
        tools: { type: "array", maxItems: 40, items: { type: "string", maxLength: 40 } },
        tags: { type: "array", maxItems: 40, items: { type: "string", maxLength: 40 } },
        stackUnread: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
      },
    },
  },
  [TICKET_FILE]: {
    title: "File a ticket for the team",
    description:
      "Files a ticket the team (and the agents that work for it) reads and fixes or drops: a tool the brand relies on that has no connector (missing_connector), something broken (bug), something you cannot do that you should (missing_capability), access you lack (permission), brand data you cannot check or explain (cant_debug_data), anything else that keeps you from doing your best for this brand (other). title is one line; detail says what you tried, what happened and what it blocks; tool names the tool when there is one; area says what it is about when there is no tool. The board gets only the kind, the tool when it is one Marley knows (any other reads as an unlisted tool there), or the area, the brand and a link to this run: your title, detail and an unlisted tool's name stay in this run for the team to open. A missing connector for the same tool from any brand becomes one ticket, and one the team closed is their decision and is not filed again; anything else is one ticket per run, and filing it again in a later turn adds that turn to it for the team. It sends nothing to anyone and promises nothing. Filing is silent: tell the person about it only when they bring that tool or problem up, and then only that you asked the team to look at it (when it answered filed: false, that it is not filed yet).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "title", "detail"],
      properties: {
        kind: { type: "string", enum: [...TICKET_KINDS] },
        title: { type: "string", minLength: 3, maxLength: 120 },
        detail: { type: "string", minLength: 1, maxLength: 2000 },
        tool: { type: "string", minLength: 1, maxLength: 60 },
        area: { type: "string", enum: [...TICKET_AREAS] },
      },
    },
  },
};

export interface BrandHostCapabilityDeps {
  /** The calling session's labels (`brand`, `member`, `role`, `turn`, `task`), undefined for an unknown session. */
  labelsOf(sessionId: string | undefined): Record<string, string> | undefined;
  /** Which of the three this host serves. */
  tools: readonly BrandHostTool[];
  stack?: BrandStack;
  tickets?: MarleyTickets;
  directory?: BrandDirectory;
  /**
   * The turn now running in the calling session (claude.ts: a member's live chat session runs many turns and days, and its labels keep the first
   * turn's), so a ticket of a later turn is its own problem (zyg-agents on 7e4df8bc5). Absent or unknown: the session's `turn` label.
   */
  turnOf?: (sessionId: string | undefined) => string | undefined;
  logger: Logger;
}

const refused = (message: string) => Object.assign(new Error(message), { code: "refused" });

/** The provider a Marley host registers (`providerSources`); remote sessions reach only the names it lists in `remoteEmbedderTools`. */
export function createBrandHostCapabilities(deps: BrandHostCapabilityDeps) {
  const descriptors = deps.tools.map((name) => ({
    protocolVersion: PROTOCOL_VERSION,
    version: VERSION,
    name,
    title: CAPABILITIES[name].title,
    description: CAPABILITIES[name].description,
    tags: ["marley", "brand"],
    inputSchema: CAPABILITIES[name].inputSchema,
    outputSchema: RESULT,
    permissions: [{ permission: name, risk: "low" }],
  }));
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name as string, descriptor]));
  return {
    id: "marley.brand-host",
    version: VERSION,
    list: () => descriptors,
    get: (name: string) => byName.get(name),
    invoke: async (name: string, value: unknown, context?: { scope?: { sessionId?: string } }) => {
      if (!byName.has(name)) throw Object.assign(new Error(`Unknown capability ${name}.`), { code: "not_found" });
      const sessionId = context?.scope?.sessionId;
      const labels = deps.labelsOf(sessionId);
      const brand = labels?.brand;
      if (!brand || !BRAND.test(brand)) throw refused(`${name} answers only inside a brand's session`);
      const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      if (name === STACK_GET) {
        if (!deps.stack) throw refused(`${name} is not available on this server`);
        // No ticket state: the server files missing-connector tickets itself, and nothing about one may reach the person (parent T8, 2026-11-22).
        const snapshot = await deps.stack.read(brand);
        return { output: { result: { ...snapshot, unsupported: snapshot.unsupported.map(({ ticketed: _ticketed, ...item }) => item) } } };
      }
      if (name === STACK_SET) {
        if (!deps.stack || !deps.directory) throw refused(`${name} is not available on this server`);
        const member = labels.member;
        if (!member || labels.role !== "front") throw refused(`${name} records only what a person said in their own direct chat`);
        // Their own message must be in the turn now running (privacy review P2, AU01): a wakeup, a task's result or a worker never answers for them.
        if (!deps.stack.speaks(brand, member)) throw refused(`${name} records only what the person said in this turn: nothing was recorded (no message of theirs is in it)`);
        // The member is rechecked on a fresh read: a label is the server's, but a row deleted since the session started is no longer a member (D143).
        const fresh = await deps.directory.get(brand, { fresh: true });
        if (!fresh || fresh.membersUnreadable) throw refused("the member list cannot be read right now, so nothing was recorded");
        if (!isMember(fresh.members.find((row) => row.id === member))) throw refused(`${name} records only what a member of this brand said`);
        const answer = deps.stack.answer({ brandId: brand, memberId: member, ...(sessionId ? { sessionId } : {}), pillar: input.pillar, tool: input.tool });
        if (!answer.ok) throw refused(answer.reason);
        // Their answer is a stack topic raised today: it starts their weekly hold, and the pillar is now known for every member of the brand.
        deps.stack.markAsked({ brandId: brand, memberId: member, ask: `pillar:${answer.pillar}` });
        return { output: { result: { recorded: true, pillar: answer.pillar, tool: answer.tool } } };
      }
      if (name === STACK_ASKED) {
        if (!deps.stack) throw refused(`${name} is not available on this server`);
        const member = labels.member;
        if (!member || !ANSWER_ROLES.has(labels.role ?? "")) throw refused(`${name} marks only an ask raised in a person's own direct chat`);
        const marked = deps.stack.markAsked({ brandId: brand, memberId: member, ask: input.ask });
        if (!marked.ok) throw refused(marked.reason);
        return { output: { result: { marked: true, ask: marked.ask } } };
      }
      if (name === STACK_DETECTED) {
        if (!deps.stack) throw refused(`${name} is not available on this server`);
        // Only the stack-scan run reports; a chat or another routine cannot set what the site "shows".
        if (labels.routine !== STACK_SCAN) throw refused(`${name} answers only the stack scan's run`);
        const recorded = await deps.stack.recordDetected({ brandId: brand, storeUrl: input.storeUrl, tools: input.tools, tags: input.tags, stackUnread: input.stackUnread });
        if (!recorded.ok) throw refused(recorded.reason);
        return { output: { result: { recorded: true, tools: recorded.tools } } };
      }
      if (!deps.tickets) throw refused(`${name} is not available on this server`);
      const requester = labels.member ? `member:${labels.member}` : `marley:${labels.role ?? "session"}`;
      const turn = deps.turnOf?.(sessionId) ?? labels.turn;
      const filed = await deps.tickets.file(brand, { requester, ...(sessionId ? { run: sessionId } : {}), ...(turn ? { turn } : {}), ...(labels.routine ? { routine: labels.routine } : {}) }, input);
      if (!filed.ok && filed.reason === "invalid") throw refused(filed.message);
      // No board, a board that did not answer, or the day's limit: a result, not an error, so the turn knows it was not filed.
      if (!filed.ok) return { output: { result: { filed: false, reason: filed.message } } };
      deps.stack?.invalidate(brand);
      return { output: { result: { filed: true, ticket: filed.ticket, alreadyFiled: filed.repeat, brandsOnTicket: filed.brands, ...(filed.decided ? { closedByTeam: true } : {}) } } };
    },
  };
}
