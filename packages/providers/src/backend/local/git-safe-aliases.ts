// Git subcommands that are auto-approved as read-only. Used by client-factory.ts to
// inject GIT_CONFIG alias overrides into the Copilot CLI subprocess env — update this
// when READ_ONLY_PREFIXES or isReadOnlyGitCommand changes.
export const GIT_SAFE_ALIAS_SUBCOMMANDS = [
  "blame",
  "branch",
  "config",
  "config",
  "describe",
  "log",
  "reflog",
  "remote",
  "rev-parse",
  "shortlog",
  "stash",
  "submodule",
  "tag",
  "worktree",
] as const;
