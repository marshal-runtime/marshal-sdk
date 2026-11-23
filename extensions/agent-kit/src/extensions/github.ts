import { createGithubChannel, GITHUB_HOST_SERVICE, type GithubHost } from "../channels/github.js";
import { CHANNEL_SERVICE, serviceToken } from "../contracts.js";

interface ActivationContext {
  services: { get<T>(token: symbol): T };
}

/** Binds the kit's GitHub `Channel` as one of the host's channels (`many`: a host binds one per channel kind). */
export function activate(context: ActivationContext) {
  const host = context.services.get<GithubHost>(serviceToken(GITHUB_HOST_SERVICE));
  return {
    serviceContributions: [{ token: serviceToken(CHANNEL_SERVICE), mode: "many" as const, binding: { useValue: createGithubChannel(host) } }],
  };
}
