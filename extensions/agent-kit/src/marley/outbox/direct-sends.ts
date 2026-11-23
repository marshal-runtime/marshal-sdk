/**
 * Every place in the agent server that may hand a message to the gateway's send client without going through outbox material and the composer. Omer's rule
 * (R149): every message to a person goes through the outbox and the composer; the only exceptions are a WhatsApp template outside the 24-hour window and
 * the phone code (which the gateway sends itself). Pieces whose bytes are a contract (approval cards, action results, team invites, files, pictures, saved
 * files, reactions, an approved alert text) are fixed outbox material (`FixedPiece`), never a direct send. Anything else that sends is a bug, and
 * `send-paths-guard.test.ts` fails on it. Each entry names the file and the function (class.method, nested functions joined by dots) and why it may send
 * directly. The inventory, with what each path sends, is `docs/knowledge/send-paths-20261118.md`.
 */
export interface DirectSendException {
  file: string;
  fn: string;
  kind: "outbox" | "implementation" | "wrapper" | "template";
  why: string;
}

export const DIRECT_SEND_EXCEPTIONS: readonly DirectSendException[] = [
  { file: "router.ts", fn: "Router.flushOutbox.send.attempt", kind: "outbox", why: "the outbox's own send: carries out the composer's frozen decision for a moment, its words, its meme and its fixed pieces" },
  { file: "channel-sender.ts", fn: "ChannelSender.send", kind: "implementation", why: "the send client itself (inspector test chat or the gateway); every caller is listed here" },
  { file: "message-events.ts", fn: "MessageEvents.counting.send", kind: "wrapper", why: "counts sends for the inspector; it passes a send through, it starts none" },
  { file: "template-send.ts", fn: "sendOutOfWindowTemplate", kind: "template", why: "R149's one exception: a Meta-approved template outside the 24-hour window, sent by the signup greeting (SD12) and by the outbox's own send for a routine's template (R151); it refuses anything that is not a template" },
];

/**
 * Where routines and extensions live (R151: "routines must go through outbox too, no exception"): no direct send and no exception may sit under these, and a
 * routine's own contract checks run as dispatch guards of the outbox's send (dispatch-guards.ts). Paths are relative to the agent server's `src`.
 */
export const ROUTINE_PATHS: readonly string[] = ["routines/", "agent-extensions/", "proactive/", "nudges/", "ahead/", "onboarding"];

/**
 * The only caller of `sendOutOfWindowTemplate` outside the outbox: the signup greeting (SD12), which is not a routine. A routine's template (the proactive
 * engine's) goes through the outbox as fixed template material (R151), and the outbox's own send makes that call (`OUTBOX_TEMPLATE_SEND`).
 */
export const TEMPLATE_CALLERS: readonly { file: string; fn: string }[] = [
  { file: "signup-greeting.ts", fn: "SignupGreeting.greet" },
];

/** Where the outbox itself sends a template piece the composer let go (`Router.deliverTemplate`), with no 24-hour window gate. */
export const OUTBOX_TEMPLATE_SEND: { file: string; fn: string } = { file: "router.ts", fn: "Router.flushOutbox.send.attempt" };
