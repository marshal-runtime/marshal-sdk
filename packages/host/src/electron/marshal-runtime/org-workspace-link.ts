export const ORG_WORKSPACE_METADATA_KEY = "marshalOrgWorkspaceId";

type OrgWorkspaceResolver = (workspaceName: string) => string | undefined;

let resolver: OrgWorkspaceResolver | null = null;

/** Installed once by the composition root; null (the default) means no workspace is ever linked. */
export function setOrgWorkspaceResolver(next: OrgWorkspaceResolver | null): void {
  resolver = next;
}

/**
 * Invocation metadata that carries the organization workspace a local workspace is linked to, next to
 * `marshalWorkspaceName`. It is empty unless the `org.workspaces` flag is on and the workspace is linked.
 */
export function orgWorkspaceMetadata(workspaceName: string | undefined): {
  readonly marshalOrgWorkspaceId?: string;
} {
  if (!resolver || !workspaceName) return {};
  const id = resolver(workspaceName);
  return id ? { [ORG_WORKSPACE_METADATA_KEY]: id } : {};
}

/** The workspace identity every runtime invocation carries: the local name plus the linked org workspace, if any. */
export function workspaceMetadata(workspaceName: string): {
  readonly marshalWorkspaceName: string;
  readonly marshalOrgWorkspaceId?: string;
} {
  return { marshalWorkspaceName: workspaceName, ...orgWorkspaceMetadata(workspaceName) };
}
