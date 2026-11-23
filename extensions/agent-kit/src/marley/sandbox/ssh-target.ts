// Extract of zygstinct apps/agent-server/src/sandbox/ssh-target.ts at 7110e58c8: only SshTarget.
/**
 * Where an SSH connection goes: a VM's private IP (today's path, byte for byte) or a sandbox reached through a ProxyCommand.
 * The alias is the host name ssh looks up in known_hosts; it is pinned from the sandbox's own host key, never accepted on first use.
 */
export type SshTarget = string | { alias: string; proxyCommand: string[] };
