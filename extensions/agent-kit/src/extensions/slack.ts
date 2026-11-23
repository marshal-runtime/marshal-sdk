import { createSlackChannel, type SlackChannelOptions } from "../channels/slack.js";
import { CHANNEL_SERVICE, serviceToken } from "../contracts.js";

/** The host service the Slack extension reads its bot token (or a call of the host's own) from. */
export const SLACK_HOST_SERVICE = "@marshal/agent-kit:slack-host";

interface ActivationContext {
  services: { get<T>(token: symbol): T };
}

/** Binds the kit's Slack `Channel` as one of the host's channels (`many`: a host binds one per channel kind). */
export function activate(context: ActivationContext) {
  const options = context.services.get<SlackChannelOptions>(serviceToken(SLACK_HOST_SERVICE));
  return {
    serviceContributions: [{ token: serviceToken(CHANNEL_SERVICE), mode: "many" as const, binding: { useValue: createSlackChannel(options) } }],
  };
}
