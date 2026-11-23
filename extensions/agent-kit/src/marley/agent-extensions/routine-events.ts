/**
 * The server events a routine can start on (`triggers.events` of `routines/<agent>.yaml`, docs/design/extension-triggers.md). This list is the one place
 * they are written: the routine file check (triggers.ts) accepts only these and the brand's own `brand.<slug>` events, a brand event's detector may
 * name the ones marked `detector` in its `when` (brand-events.ts), and the Routines section of the worker and chat prompts (prompt-layers/routines.ts)
 * is generated from it.
 */
export interface RoutineEventSpec {
  event: string;
  /** When the server emits it, in a few plain words. */
  when: string;
  /** The facts the run's input carries beside `trigger` and `event` (a `match` filter may name them). */
  facts: readonly string[];
  /** A brand's own routine may start on it. False for an event whose emitter waits for one server routine's answer (none today; the agenda's agenda-due was one until R157). */
  brandRoutines: boolean;
  /** A brand event's detector may run on it (`when.events`). */
  detector: boolean;
}

export const ROUTINE_EVENTS: readonly RoutineEventSpec[] = [
  { event: "data.sync.completed", when: "the brand's warehouse was rebuilt after a data sync (Shopify orders included)", facts: ["tables", "finishedAt"], brandRoutines: true, detector: true },
  { event: "first-sync-complete", when: "the brand's first data sync finished (once per brand)", facts: ["website"], brandRoutines: true, detector: true },
  { event: "source.connected", when: "a data source was connected", facts: ["source"], brandRoutines: true, detector: true },
  { event: "intake.completed", when: "the brand's signup intake was finished", facts: [], brandRoutines: true, detector: true },
];

export const ROUTINE_EVENT_NAMES: readonly string[] = ROUTINE_EVENTS.map((spec) => spec.event);
export const isRoutineEventName = (event: string): boolean => ROUTINE_EVENT_NAMES.includes(event);
