// "https", not "node:https": the runtime's extension loader hands a bundle only its reviewed builtins, and lists this one by its bare name.
import * as https from "https";

import { channelMessageId, type Channel, type ChannelPosted } from "../contracts.js";
import type { ComposedPart } from "../marley/outbox/outbox.js";
import type { ConversationKey } from "../marley/store.js";

/** The channel kind this binding serves: a conversation key whose `channel` is `slack`. */
export const SLACK_KIND = "slack";

/** Slack's Web API. */
export const SLACK_API = "https://slack.com/api";

/** The reaction that tells a person their message was taken, when there is no picker or Slack refuses the one picked. */
export const ACK_REACTION = "eyes";

/** Slack's error for a reaction the bot already added: acknowledging twice is not a failure. */
export const ALREADY_REACTED = "already_reacted";

/** What one Web API call answered: Slack's `ok`, its `ts` when it posted, its error code when it refused. */
export interface SlackAnswer {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** One Web API call; a thrown error means the call itself failed (the outbox then counts the send as unknown, never as sent). */
export type SlackCall = (method: string, body: Record<string, unknown>) => Promise<SlackAnswer>;

/**
 * How the binding reaches Slack: the bot token, or a call of the host's own (a test, a proxy). `pickReaction` chooses the acknowledgement for a
 * person's words (zyg-agents' Jev chooser); without it every message gets ACK_REACTION.
 */
export interface SlackChannelOptions {
  token?: string;
  apiBase?: string;
  call?: SlackCall;
  pickReaction?: (text: string) => Promise<string>;
}

/** Slack refused a reaction. */
class SlackRefusal extends Error {
  constructor(readonly code: string) {
    super(`Slack refused: ${code}`);
  }
}

/** The conversation id of a Slack key: `<channel>` for a channel or DM, `<channel>:<thread ts>` for a thread. */
export function slackPlace(key: ConversationKey): { channel: string; threadTs: string | null } {
  const at = key.conversationId.indexOf(":");
  return at < 0 ? { channel: key.conversationId, threadTs: null } : { channel: key.conversationId.slice(0, at), threadTs: key.conversationId.slice(at + 1) || null };
}

/** A Web API call over https with the bot token. */
export function slackHttpCall(token: string, apiBase: string = SLACK_API): SlackCall {
  return (method, body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const request = https.request(`${apiBase}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8", "content-length": payload.length } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as SlackAnswer);
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
}

/**
 * The Slack binding of the kit's `Channel`: a text part (or a fixed part, as its text) is posted as the bot in the key's thread, or at the top of the
 * channel when the key has none. Slack's refusal is `refused`; a failed call is `unknown`, so the outbox never takes it as sent. A key already
 * posted in this process is not posted again. A voice part has no Slack form: `refused`. A person's message is acknowledged with the reaction the
 * picker chooses for its words, and with ACK_REACTION when there is no picker, it fails, or Slack refuses the one it chose.
 */
export function createSlackChannel(options: SlackChannelOptions): Channel {
  const call = options.call ?? (options.token ? slackHttpCall(options.token, options.apiBase) : null);
  if (!call) throw new Error("the Slack channel needs a bot token or a call");
  const sent = new Map<string, ChannelPosted>();
  const post = async (key: ConversationKey, part: Pick<ComposedPart, "kind" | "text">, idempotencyKey: string): Promise<ChannelPosted> => {
    const known = sent.get(idempotencyKey);
    if (known) return known;
    if (part.kind === "voice" || !part.text.trim()) return { outcome: "refused", id: null };
    const place = slackPlace(key);
    let answer: SlackAnswer;
    try {
      answer = await call("chat.postMessage", { channel: place.channel, text: part.text, ...(place.threadTs ? { thread_ts: place.threadTs } : {}) });
    } catch {
      return { outcome: "unknown", id: null };
    }
    if (!answer.ok || !answer.ts) return { outcome: "refused", id: null };
    const posted: ChannelPosted = { outcome: "sent", id: answer.ts };
    sent.set(idempotencyKey, posted);
    return posted;
  };
  const react = async (key: ConversationKey, messageId: string, name: string): Promise<void> => {
    const answer = await call("reactions.add", { channel: slackPlace(key).channel, timestamp: channelMessageId(messageId), name });
    if (!answer.ok && answer.error !== ALREADY_REACTED) throw new SlackRefusal(answer.error ?? "unknown");
  };
  return {
    kind: SLACK_KIND,
    post,
    async send(key, part, idempotencyKey) {
      return (await post(key, part, idempotencyKey)).outcome;
    },
    async acknowledge(key, messageId, text) {
      const name = options.pickReaction ? await options.pickReaction(text ?? "").catch(() => ACK_REACTION) : ACK_REACTION;
      try {
        await react(key, messageId, name);
      } catch (error) {
        if (name === ACK_REACTION) throw error;
        await react(key, messageId, ACK_REACTION);
      }
    },
  };
}
