// The permission-card vocabulary, moved from the desktop's common/marshal-constants.ts.
/**
 * Semantic actions for permission card responses.
 * Old values ("allow-type", "allow-all") kept temporarily during migration — removed in cleanup task.
 */
export type PermissionAction =
  | "allow"
  | "allow-type"
  | "allow-all"
  | "allow-session"
  | "always-allow"
  | "deny";
