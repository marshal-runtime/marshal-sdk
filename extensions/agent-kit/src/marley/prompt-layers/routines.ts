import { ROUTINE_EVENTS } from "../agent-extensions/routine-events.js";
import { EVENT_NAMES, FILTER_FIELDS } from "../agent-extensions/schedules/types.js";

/**
 * The Routines section of the worker's and the chat's prompts (Omer R150, 2026-11-18), generated from the event lists in code so a prompt never
 * names an event the server does not emit: routine-events.ts (what a routine file may start on) and schedules/types.ts (what a chat may subscribe
 * to). The persona layers carry `{{routines_worker}}`, `{{routines_front}}` and `{{events_subscribe}}`; prompt-v2.ts fillV2 puts these in.
 */

const facts = (list: readonly string[]): string => (list.length > 0 ? `; facts: ${list.join(", ")}` : "");
const routineEventLines = (): string =>
  ROUTINE_EVENTS.filter((spec) => spec.brandRoutines)
    .map((spec) => `  - \`${spec.event}\`: ${spec.when}${facts(spec.facts)}`)
    .join("\n");
const detectorEvents = (): string => ROUTINE_EVENTS.filter((spec) => spec.detector).map((spec) => spec.event).join(", ");

/** The worker's section: it can list, write, change and approve routines (zs.extensions.list / act). */
export function routinesWorkerGuide(): string {
  return `# Routines

A routine is an extension package of this brand that runs on its own: a schedule, an event or another routine finishing starts it, and it works like you do, then hands what it made to the outbox. Marley's own routines (the daily brief, free time, the pixel check and the rest) are packages too, and the brand can change them.

- **See what runs.** zs.extensions.list shows each routine with its version, triggers, state and proposals, and the brand's own events. Read it before you write or change one; never make a second routine for what one already does.
- **Make one** (the owner wants something to run again, and you have zs.extensions.act): queue ONE zs.extensions.act op submit {extensionId "@brand/<slug>", files, summary}. Files: runtime-extension.json (identity @brand/<slug>, one agent: id, profile {prompt "profiles/<slug>.prompt.md", extensions}, task "tasks/<slug>.md", outputs, ports, routine "routines/<slug>.yaml"), those files, and routines/<slug>.yaml (title, triggers, body {extension {id, agent}}, enabled). The extension-authoring skill has the exact format; read it first.
- **What a routine covers or says** (no Meta in the brief, a different angle, naming every source, what counts as normal, text or video) is not a new package: save it with zs.routines.set_override when this turn lists it (its own note says how); the next run reads it.
- **Change one** (a new time, a new trigger, a different output, the owner's daily brief included): submit the whole package again under its own id (\`@marley/daily-brief\` for Marley's brief) with the change. The brand keeps its own version; nothing changes until the owner approves it. To stop one, set \`enabled: false\` in its routine file.
- **Triggers**, in the routine file's \`triggers\` (any mix; a routine with none runs only by hand, \`manual: true\`):
  - \`schedules\`: five-field crons, with \`timezone: "brand"\` (the shop's zone) or an IANA zone.
  - \`events\`: event names, or \`{event, match: {field: value}}\` to start only when the event's facts equal the value (a list matches any of its values). The server events a routine can start on:
${routineEventLines()}
  - and the brand's own events \`brand.<slug>\` (below), with their payload fields as facts.
  - \`after\`: \`{routine: "<agent id>" | [ids], mode: "any" | "all", notBefore: "HH:MM", within: "6h"}\` runs it when that routine of the brand finished well: this is how routines chain (\`after: {routine: "daily-brief"}\` runs once the brief was built). \`notBefore\` holds it until that local time; \`within\` drops it when the wait is longer, so leave \`within\` out unless a late run is worse than none.
- **Input.** Every run gets \`today\`, \`yesterday\`, \`slot\` and \`timezone\`; an event run also gets \`trigger: "event"\`, \`event\` and the event's facts (\`{{input.<fact>}}\` in the task file).
- **Outputs.** The agent's \`outputs\` and \`ports\` say what it may make: \`[{"kind": "reply-intent"}]\` with port \`reply\` (and \`@marley/reply\` in profile.extensions) to say something to the owner; \`file\` or \`artifact\` for a file it leaves; none for a routine that only works silently (it can still keep memory). To change what a routine sends, change these and its prompt and submit again.
- **Sending.** A routine never messages anyone itself: it runs in the DM of the member who approved it, and what it proposes with the reply port goes to that chat's outbox, which decides what is sent and when, under the same rules as every message (the 24-hour window, opt-outs, the owner's hold). Never promise when it lands.
- **Brand events** (the owner wants to hear when something happens, or a trigger several routines should share): define \`brand.<slug>\` in a package's contributes.events with a detector events/<slug>.ts (\`check(input, ctx)\` returns null or a flat payload; \`when\` a schedule and/or one of ${detectorEvents()}). Routines then list it in \`triggers.events\`, and chats subscribe with zs.events.subscribe and a field filter. A detector never runs on a brand event, so events cannot loop. The extension-authoring skill has the worked example.
${eventsSubscribeLine()}
- **The owner's yes.** The server dry-runs every submit (nothing is sent) and proposes it only if it passed: tell the owner in plain words what it does, when it runs and what they will get, ask for their yes, and never say it is on. When their later message is a yes to a proposed version, queue op approve {extensionId, version, approveToken from list, routineId "<slug>"} in that turn; never in the turn that proposed it.`;
}

/** The chat's (the inbox's) section: it hands routine work to the background copy and knows what triggers exist. */
export function routinesFrontGuide(): string {
  const names = ROUTINE_EVENTS.filter((spec) => spec.brandRoutines).map((spec) => spec.event).join(", ");
  return `- **Routines** (something that should run on its own, start when something happens or after another routine, or a change to one, the daily brief included): the background copy makes the change. What a routine covers or says is saved for its next run; a new routine or a new time or trigger is proposed to the owner and runs only after their yes to that proposal. Hand it over in their words, and hand over their later yes to a proposal too. A routine can start on a schedule, after another routine finished (one chain: "after the brief is built, ..."), or on an event: ${names}, or one the brand defines (brand.<slug>, such as a big order). Its messages reach the person through the outbox like yours, only within the reply window. Never say a routine is on before the owner approved it.`;
}

/** The chat subscription line (reference layer): the events zs.events.subscribe takes and the fields each filter may name. */
export function eventsSubscribeLine(): string {
  const about: Partial<Record<(typeof EVENT_NAMES)[number], string>> = {
    "data.sync.completed": "the brand's warehouse was rebuilt after a data sync, Shopify orders included; ",
    "data.source.ready": "one source's data was built in the warehouse (dataSource is meta_ads, shopify, flashy, google_ads, ...): the event for \"I'll do it when the data lands\"; ",
  };
  const server = EVENT_NAMES.map((event) => `${event} (${about[event] ?? ""}filter by ${FILTER_FIELDS[event].join(", ")} only, or not at all)`).join(", ");
  return `- zs.events.subscribe {event, prompt, filter?, once?}: ${server}; and the brand's own events brand.<slug> (zs.events.list shows them; filter on any of their payload fields). once: true ends it with its first fire (a wait for one thing, such as a source landing); without it, it fires every time. zs.events.list, zs.events.unsubscribe {id}.`;
}
