import {
  OrgClient,
  fetchOrgDiscovery,
  type FetchLike,
  type OrgFeature,
  type OrgWorkspace,
} from "@marshal/agent-runtime-org";
import { createInMemoryOrgProvider } from "@marshal/agent-runtime-org/testing";

export const ALICE = "user:alice";
export const BOB = "user:bob";
export const CAROL = "user:carol";
export const OUTSIDER = "user:mallory";

/** An in-memory organization with three members and one workspace, serving every M2 feature. */
export function createTestOrg(
  options: {
    fetchWrapper?: (inner: FetchLike) => FetchLike;
    features?: OrgFeature[];
    workspaces?: OrgWorkspace[];
  } = {},
) {
  const provider = createInMemoryOrgProvider({
    features: options.features ?? [
      "signIn",
      "directory",
      "workspaces",
      "sessions",
      "mentions",
      "notifications",
    ],
    users: [
      { principal: ALICE, email: "alice@example.test", displayName: "Alice" },
      { principal: BOB, email: "bob@example.test", displayName: "Bob" },
      { principal: CAROL, email: "carol@example.test", displayName: "Carol" },
    ],
    workspaces: options.workspaces ?? [
      {
        id: "ws:platform",
        displayName: "Platform",
        repositories: [{ repository: "acme/platform", defaultBranch: "main" }],
      },
    ],
  });
  const fetchImpl: FetchLike = options.fetchWrapper
    ? options.fetchWrapper(provider.fetch)
    : provider.fetch;
  async function clientFor(principal: `user:${string}`): Promise<OrgClient> {
    const discovery = await fetchOrgDiscovery(provider.orgUrl, { fetch: provider.fetch });
    const token = provider.issueToken(principal);
    return new OrgClient({ discovery, accessToken: async () => token, fetch: fetchImpl });
  }
  return { provider, clientFor };
}
