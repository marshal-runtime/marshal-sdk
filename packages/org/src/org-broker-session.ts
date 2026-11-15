import { createRuntimeServiceToken } from "@marshal/runtime";

import type {
  OrgBrokerFetchInit,
  OrgBrokerFetchResult,
  OrgBrokerIdentity,
} from "./org-broker-fetch";

export type { OrgBrokerFetchInit, OrgBrokerFetchResult, OrgBrokerIdentity };

export type OrgIdentityService = () => Promise<OrgBrokerIdentity | undefined>;
export type OrgBrokerFetchService = (
  path: string,
  init?: OrgBrokerFetchInit,
) => Promise<OrgBrokerFetchResult>;

/** The signed-in person: `{email, orgId, orgDisplayName}`, never a credential. */
export const ORG_IDENTITY_SERVICE_KEY = "@marshal/org:identity";
export const ORG_IDENTITY_SERVICE =
  createRuntimeServiceToken<OrgIdentityService>(ORG_IDENTITY_SERVICE_KEY);

/** Read requests to the org's `/v1/broker/` routes, made by the host with a fresh bearer the extension never sees. */
export const ORG_BROKER_FETCH_SERVICE_KEY = "@marshal/org:broker-fetch";
export const ORG_BROKER_FETCH_SERVICE = createRuntimeServiceToken<OrgBrokerFetchService>(
  ORG_BROKER_FETCH_SERVICE_KEY,
);

/** Extensions that may use the org services; a tenant policy list replaces it. */
export const DEFAULT_ORG_BROKER_SESSION_EXTENSIONS: readonly string[] = [
  "@marshal/brain",
  "@zyg/marshal-runtime-extension",
  "@marshal/vault",
];

export function orgBrokerSessionAllowed(
  extensionIdentity: string,
  policy: { orgBrokerSessionExtensions?: readonly string[] },
): boolean {
  return (policy.orgBrokerSessionExtensions ?? DEFAULT_ORG_BROKER_SESSION_EXTENSIONS).includes(
    extensionIdentity,
  );
}

export function createOrgIdentityService(source: {
  getBrokerIdentity(): Promise<OrgBrokerIdentity | undefined>;
}): OrgIdentityService {
  return async () => {
    try {
      return await source.getBrokerIdentity();
    } catch {
      return undefined;
    }
  };
}

export function createOrgBrokerFetchService(source: {
  brokerFetch(path: string, init?: OrgBrokerFetchInit): Promise<OrgBrokerFetchResult>;
}): OrgBrokerFetchService {
  return (path, init) => source.brokerFetch(path, init);
}
