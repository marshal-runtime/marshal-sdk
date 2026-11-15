import { OrgApiError } from "@marshal/agent-runtime-org";

import type { OrgSlackDestination, OrgSlackDestinationsRequest, OrgSlackDestinationsResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";

const log = createLogger("OrgSlackDestinations");

const MAX_DESTINATIONS = 50;
const MAX_QUERY_CHARS = 100;
const MAX_CURSOR_CHARS = 512;

export interface OrgSlackDestinationsDeps {
  getFlags: () => OrgFlags;
  requestJson: (method: "GET", route: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseDestination(value: unknown): OrgSlackDestination | null {
  if (!isRecord(value)) return null;
  const { kind, id, name, visibility } = value;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return null;
  if (visibility !== "private" && visibility !== "channel") return null;
  if (kind === "dm" && id === null) return { kind, id: null, name, visibility };
  if (kind === "channel" && typeof id === "string" && /^[CG][A-Z0-9]{2,40}$/.test(id)) {
    return { kind, id, name, visibility };
  }
  return null;
}

/**
 * The Slack places a cloud run's thread can go (`GET /v1/slack/destinations`). Inert unless
 * `org.cloudMove` is on. A route that answers 404 means the organization does not offer it, and the
 * dialog then keeps the direct message without saying anything.
 */
export class OrgSlackDestinations {
  constructor(private readonly deps: OrgSlackDestinationsDeps) {}

  async list(request: OrgSlackDestinationsRequest): Promise<OrgSlackDestinationsResult> {
    if (this.deps.getFlags().cloudMove !== true) return { success: false, error: "disabled" };
    const params = new URLSearchParams();
    if (request.query) params.set("query", request.query.slice(0, MAX_QUERY_CHARS));
    if (request.cursor && request.cursor.length <= MAX_CURSOR_CHARS) {
      params.set("cursor", request.cursor);
    }
    if (request.limit !== undefined) {
      params.set(
        "limit",
        String(Math.min(Math.max(Math.trunc(request.limit), 1), MAX_DESTINATIONS)),
      );
    }
    if (request.sessionId) params.set("session", request.sessionId);
    const query = params.toString();
    try {
      const body = await this.deps.requestJson(
        "GET",
        `/v1/slack/destinations${query ? `?${query}` : ""}`,
      );
      if (!isRecord(body) || !Array.isArray(body.destinations)) {
        return { success: false, error: "invalid-response" };
      }
      const destinations = body.destinations
        .slice(0, MAX_DESTINATIONS + 1)
        .map(parseDestination)
        .filter((destination): destination is OrgSlackDestination => destination !== null);
      const nextCursor =
        typeof body.nextCursor === "string" && body.nextCursor.length <= MAX_CURSOR_CHARS
          ? body.nextCursor
          : undefined;
      return {
        success: true,
        destinations,
        ...(nextCursor ? { nextCursor } : {}),
        truncated: body.truncated === true,
      };
    } catch (error) {
      if (error instanceof OrgApiError && error.status === 404) {
        return { success: false, error: "unavailable" };
      }
      const failure = classifyOrgFailure(error);
      log.warn(`Slack destinations failed: code=${failure.code} status=${failure.status ?? 0}`);
      return { success: false, error: failure.code };
    }
  }
}
