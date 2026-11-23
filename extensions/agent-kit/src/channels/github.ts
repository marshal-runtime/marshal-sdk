import type { Channel, ChannelPosted } from "../contracts.js";
import type { ComposedPart } from "../marley/outbox/outbox.js";
import type { ConversationKey } from "../marley/store.js";

/** The channel kind this binding serves: a conversation key whose `channel` is `github`. */
export const GITHUB_KIND = "github";

/** The host service the GitHub extension writes through: its App or token stays in the host, which comments and answers the comment's URL. */
export const GITHUB_HOST_SERVICE = "@marshal/agent-kit:github-host";

/** The host's GitHub: one comment on `owner/repo`'s pull request or issue `number`, answering the comment's URL. */
export interface GithubHost {
  comment(repo: string, number: number, body: string): Promise<string>;
}

const ISSUE_NUMBER = /^[1-9][0-9]*$/;

/** The conversation id of a GitHub key: `<owner/repo>:<number>`. */
export function githubPlace(key: ConversationKey): { repo: string; number: number | null } {
  const at = key.conversationId.indexOf(":");
  const repo = at < 0 ? key.conversationId : key.conversationId.slice(0, at);
  const number = at < 0 ? "" : key.conversationId.slice(at + 1);
  return { repo, number: ISSUE_NUMBER.test(number) ? Number(number) : null };
}

/**
 * The GitHub binding of the kit's `Channel`: a part becomes one comment on the conversation's pull request or issue, written by the host; its id is
 * the comment's URL. A key with no issue number, an empty part or a voice part is `refused`; a failed comment is `unknown`. A key already sent in
 * this process is not posted again. Acknowledging does nothing: the comment that follows is the acknowledgement.
 */
export function createGithubChannel(host: GithubHost): Channel {
  const sent = new Map<string, ChannelPosted>();
  const post = async (key: ConversationKey, part: Pick<ComposedPart, "kind" | "text">, idempotencyKey: string): Promise<ChannelPosted> => {
    const known = sent.get(idempotencyKey);
    if (known) return known;
    const place = githubPlace(key);
    if (place.number === null || part.kind === "voice" || !part.text.trim()) return { outcome: "refused", id: null };
    let url: string;
    try {
      url = await host.comment(place.repo, place.number, part.text);
    } catch {
      return { outcome: "unknown", id: null };
    }
    const posted: ChannelPosted = { outcome: "sent", id: url };
    sent.set(idempotencyKey, posted);
    return posted;
  };
  return {
    kind: GITHUB_KIND,
    post,
    async send(key, part, idempotencyKey) {
      return (await post(key, part, idempotencyKey)).outcome;
    },
    async acknowledge() {},
  };
}
