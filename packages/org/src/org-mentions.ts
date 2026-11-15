import {
  OrgApiError,
  isPrincipal,
  type OrgClient,
  type UserPrincipal,
} from "@marshal/agent-runtime-org";

import type { OrgDirectorySearchResult, OrgMentionRequest, OrgMentionResult } from "./contract/org-types";
import { createLogger } from "../host-deps";
import { grantableRoles, isGrantableRole } from "./common/org-roles";
import { classifyOrgFailure } from "./org-errors";
import type { OrgFlags } from "./org-service";
import type { OrgSessionSharing } from "./org-session-sharing";

const log = createLogger("OrgMentions");

const DIRECTORY_LIMIT = 8;
/** The contract's largest directory page; a multi-word query asks for all of it, then filters here. */
const DIRECTORY_MAX_LIMIT = 50;

function isUserPrincipal(value: string): value is UserPrincipal {
  return isPrincipal(value) && value.startsWith("user:");
}

function longestWord(words: readonly string[]): string {
  return words.reduce((best, word) => (word.length > best.length ? word : best));
}

function matchesEveryWord(
  entry: { displayName: string; email?: string },
  words: readonly string[],
) {
  const haystacks = [entry.displayName, entry.email ?? ""].map((text) => text.toLowerCase());
  return words.every((word) => haystacks.some((text) => text.includes(word.toLowerCase())));
}

type MentionClient = Pick<
  OrgClient,
  "supports" | "whoami" | "searchDirectory" | "getSession" | "grantSession"
>;

export interface OrgMentionsDeps {
  getFlags: () => OrgFlags;
  getClient: () => Promise<MentionClient | null>;
  sharing: Pick<OrgSessionSharing, "preview" | "share">;
}

/**
 * `@` mentions: directory search for the composer, and "grant a role and notify" for a person picked.
 * A mention shares the session first, so the grantee has something to open. Inert unless `org.mentions` is on.
 */
export class OrgMentions {
  constructor(private readonly deps: OrgMentionsDeps) {}

  private get enabled(): boolean {
    return this.deps.getFlags().mentions === true;
  }

  async searchDirectory(query: string): Promise<OrgDirectorySearchResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return { success: true, entries: [] };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (!client.supports("directory")) return { success: false, error: "directory-unsupported" };
      // A provider may match a whole multi-word query against one field, or not at all, so the
      // directory is asked with the longest word and the other words are matched here.
      const words = trimmed.split(/\s+/);
      const multiWord = words.length > 1;
      const asked = multiWord ? longestWord(words) : trimmed;
      const [entries, self] = await Promise.all([
        client.searchDirectory({
          query: asked,
          limit: multiWord ? DIRECTORY_MAX_LIMIT : DIRECTORY_LIMIT,
        }),
        client.whoami(),
      ]);
      return {
        success: true,
        entries: entries
          .filter((entry) => entry.kind === "user" && entry.principal !== self.principal)
          .filter((entry) => !multiWord || matchesEveryWord(entry, words))
          .slice(0, DIRECTORY_LIMIT)
          .map((entry) => ({
            principal: entry.principal,
            displayName: entry.displayName,
            ...(entry.email ? { email: entry.email } : {}),
          })),
      };
    } catch (error) {
      if (error instanceof OrgApiError && error.status === 503) {
        return { success: false, error: "directory-unavailable" };
      }
      const failure = classifyOrgFailure(error);
      log.warn(`Directory search failed: code=${failure.code} status=${failure.status ?? 0}`);
      return { success: false, error: failure.code };
    }
  }

  async mention(request: OrgMentionRequest): Promise<OrgMentionResult> {
    if (!this.enabled) return { success: false, error: "disabled" };
    if (!isGrantableRole(request.role)) return { success: false, error: "invalid-role" };
    if (!isUserPrincipal(request.principal)) return { success: false, error: "invalid-principal" };
    try {
      const client = await this.deps.getClient();
      if (!client) return { success: false, error: "not-signed-in" };
      if (
        !client.supports("sessions") ||
        !client.supports("mentions") ||
        !client.supports("notifications")
      ) {
        return { success: false, error: "mentions-unsupported" };
      }
      const preview = await this.deps.sharing.preview(request.sessionId);
      if (!preview.success) return { success: false, error: preview.error };
      if (preview.restrictedItems.length > 0 && request.acknowledgeRestricted !== true) {
        return {
          success: false,
          error: "restricted-needs-acknowledgement",
          restrictedItems: preview.restrictedItems,
        };
      }
      const shared = await this.deps.sharing.share(request.sessionId);
      if (!shared.success) return { success: false, error: shared.error };
      if (shared.state === "queued") return { success: false, error: "unreachable" };

      const view = await client.getSession(request.sessionId);
      if (!grantableRoles(view.role).includes(request.role)) {
        return {
          success: false,
          error: view.role === "viewer" ? "forbidden" : "role-above-own",
        };
      }
      const result = await client.grantSession(request.sessionId, {
        principal: request.principal,
        role: request.role,
        mention: {},
      });
      return {
        success: true,
        role: request.role,
        notified: result.notificationId !== undefined,
      };
    } catch (error) {
      const failure = classifyOrgFailure(error);
      log.warn(`Mention failed: code=${failure.code} status=${failure.status ?? 0}`);
      return { success: false, error: failure.code };
    }
  }
}
