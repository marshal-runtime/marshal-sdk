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

/** What one Web API call answered: Slack's `ok`, its `ts` when it posted, its error code when it refused, and the upload fields of the file calls. */
export interface SlackAnswer {
  ok: boolean;
  ts?: string;
  error?: string;
  upload_url?: string;
  file_id?: string;
  files?: { id: string }[];
}

/**
 * One Web API call; a thrown error means the call itself failed (the outbox then counts the send as unknown, never as sent). `form` sends the body
 * form-encoded, as Slack's file upload methods take it.
 */
export type SlackCall = (method: string, body: Record<string, unknown>, form?: boolean) => Promise<SlackAnswer>;

/** Spoken audio of a voice part: its bytes and their type (Marley's speech answers Ogg Opus). */
export interface SlackSpoken {
  data: Buffer;
  mimeType: string;
}

/** Puts a file's bytes to the upload URL Slack gave (files.getUploadURLExternal); throws when Slack did not take them. */
export type SlackUpload = (url: string, data: Buffer, mimeType: string) => Promise<void>;

/**
 * How the binding reaches Slack: the bot token, or a call of the host's own (a test, a proxy). `pickReaction` chooses the acknowledgement for a
 * person's words (zyg-agents' Jev chooser); without it every message gets ACK_REACTION. `speak` turns a voice part into audio (the host's Marley
 * speech); without it a voice part is refused. `upload` puts the audio's bytes to Slack (default: an https POST).
 */
export interface SlackChannelOptions {
  token?: string;
  apiBase?: string;
  call?: SlackCall;
  pickReaction?: (text: string) => Promise<string>;
  speak?: (part: { text: string; lang: string | null; voiceName: string | null }) => Promise<SlackSpoken>;
  upload?: SlackUpload;
}

/** The file name a voice note is uploaded under, by its audio type. */
export const voiceFileName = (mimeType: string): string => (/ogg|opus/i.test(mimeType) ? "voice.ogg" : /mpeg|mp3/i.test(mimeType) ? "voice.mp3" : /wav/i.test(mimeType) ? "voice.wav" : "voice.audio");

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

const formOf = (body: Record<string, unknown>): string =>
  new URLSearchParams(Object.entries(body).map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value)])).toString();

/** A Web API call over https with the bot token. */
export function slackHttpCall(token: string, apiBase: string = SLACK_API): SlackCall {
  return (method, body, form) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(form ? formOf(body) : JSON.stringify(body));
      const type = form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8";
      const request = https.request(`${apiBase}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": type, "content-length": payload.length } }, (response) => {
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

/** Puts bytes to a Slack upload URL over https: Slack answers 200 when it took them. */
export const slackHttpUpload: SlackUpload = (url, data, mimeType) =>
  new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", headers: { "content-type": mimeType, "content-length": data.length } }, (response) => {
      response.resume();
      response.on("end", () => (response.statusCode === 200 ? resolve() : reject(new Error(`Slack upload answered ${response.statusCode}`))));
    });
    request.on("error", reject);
    request.end(data);
  });

/**
 * The Slack binding of the kit's `Channel`: a text part (or a fixed part, as its text) is posted as the bot in the key's thread, or at the top of the
 * channel when the key has none. Slack's refusal is `refused`; a failed call is `unknown`, so the outbox never takes it as sent. A key already
 * posted in this process is not posted again. A voice part is spoken by the host's `speak` and uploaded into the same place as a voice note (Slack's
 * external upload: an upload URL, the bytes, then completing the upload in the channel and thread); its id is the file's id. Without `speak` a voice
 * part is `refused`, and a voice part that could not be spoken is `unknown`. A person's message is acknowledged with the reaction the picker chooses
 * for its words, and with ACK_REACTION when there is no picker, it fails, or Slack refuses the one it chose.
 */
export function createSlackChannel(options: SlackChannelOptions): Channel {
  const call = options.call ?? (options.token ? slackHttpCall(options.token, options.apiBase) : null);
  if (!call) throw new Error("the Slack channel needs a bot token or a call");
  const upload = options.upload ?? slackHttpUpload;
  const sent = new Map<string, ChannelPosted>();
  const voice = async (key: ConversationKey, part: Pick<ComposedPart, "text"> & Partial<Pick<ComposedPart, "lang" | "voiceName">>): Promise<ChannelPosted> => {
    if (!options.speak) return { outcome: "refused", id: null };
    const place = slackPlace(key);
    let fileId: string;
    try {
      const spoken = await options.speak({ text: part.text, lang: part.lang ?? null, voiceName: part.voiceName ?? null });
      const ticket = await call("files.getUploadURLExternal", { filename: voiceFileName(spoken.mimeType), length: String(spoken.data.length) }, true);
      if (!ticket.ok || !ticket.upload_url || !ticket.file_id) return { outcome: "refused", id: null };
      await upload(ticket.upload_url, spoken.data, spoken.mimeType);
      fileId = ticket.file_id;
    } catch {
      return { outcome: "unknown", id: null };
    }
    let done: SlackAnswer;
    try {
      done = await call("files.completeUploadExternal", { files: [{ id: fileId, title: "Voice note" }], channel_id: place.channel, ...(place.threadTs ? { thread_ts: place.threadTs } : {}) }, true);
    } catch {
      return { outcome: "unknown", id: null };
    }
    return done.ok ? { outcome: "sent", id: fileId } : { outcome: "refused", id: null };
  };
  const post = async (key: ConversationKey, part: Pick<ComposedPart, "kind" | "text"> & Partial<Pick<ComposedPart, "lang" | "voiceName">>, idempotencyKey: string): Promise<ChannelPosted> => {
    const known = sent.get(idempotencyKey);
    if (known) return known;
    if (!part.text.trim()) return { outcome: "refused", id: null };
    if (part.kind === "voice") {
      const spoken = await voice(key, part);
      if (spoken.outcome === "sent") sent.set(idempotencyKey, spoken);
      return spoken;
    }
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
