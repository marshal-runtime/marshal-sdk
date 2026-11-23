/**
 * Where an SSH connection goes: a VM's private IP (today's path, byte for byte) or a sandbox reached through a ProxyCommand.
 * The alias is the host name ssh looks up in known_hosts; it is pinned from the sandbox's own host key, never accepted on first use.
 */
export type SshTarget = string | { alias: string; proxyCommand: string[] };

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export const targetKey = (target: SshTarget): string => (typeof target === "string" ? target : `dt-target:${target.alias}`);

/** The host-key and transport options of a target, placed where `StrictHostKeyChecking` sits in the VM argument list. */
export function sshTargetArgs(target: SshTarget): string[] {
  if (typeof target === "string") return ["-o", "StrictHostKeyChecking=accept-new"];
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(target.alias) || target.proxyCommand.length === 0) throw new Error("invalid ssh target");
  return ["-o", "StrictHostKeyChecking=yes", "-o", `ProxyCommand=${target.proxyCommand.map(quote).join(" ")}`];
}
