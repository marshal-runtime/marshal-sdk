import type { SessionRecord } from "./session-store.js";

/**
 * The agent profile of a session: which extensions' skills it sees, plus skills named on their own. A session
 * without either field sees every installed extension skill (today's behaviour). Same rule as the desktop's
 * listSkillsForSession (packages/marshal-providers engine/sessions.ts).
 */
export function skillVisibleTo(
  skill: { extension: string; name: string },
  session: Pick<SessionRecord, "extensions" | "skills"> | undefined,
): boolean {
  if (!session || (session.extensions === undefined && session.skills === undefined)) return true;
  return session.extensions?.includes(skill.extension) === true || session.skills?.includes(skill.name) === true;
}

/** The launch fields of an agent profile this host applies. test/profile-pins.test.ts fails for one without an observed effect. */
export const PROFILE_PINS = ["extensions", "skills", "mcpServers", "systemPromptAppend", "nativeTools"] as const;
