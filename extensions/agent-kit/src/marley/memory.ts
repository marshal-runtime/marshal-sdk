// Extract of zygstinct apps/agent-server/src/memory.ts at 7110e58c8: only Viewer.
export type ViewerKind = "dm" | "group" | "control";

/** The conversation a session serves. */
export interface Viewer {
  kind: ViewerKind;
  /** The person in a DM (brand_members.id). */
  memberId?: string;
}
