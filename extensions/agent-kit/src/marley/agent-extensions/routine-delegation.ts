// Forks and lanes of a routine run (Omer R9, 2026-11-19: "free-time run should be able to fork and start new lanes, too").
//
// A routine run is one session on the brand's sandbox; the SDK's own fork tools do not fit it: a host fork reports when it goes idle as a new turn of its
// parent, and a routine run's session takes no second turn of its own (its next turn would look like a new fire). So the routine engine's host answers three
// capabilities itself (routine-host-capabilities.ts):
// - `marley.fork.run`: parts of the calling run, each a child session on the same brand sandbox, home and data grant, with the run's profile, model and
//   tools. The call waits for every fork and returns their final messages: the result comes back into the run. A fork sends nothing (its send folder is never
//   read).
// - `marley.lane.start`: a standalone background run for the brand that outlives the run that started it. It files its findings in brand memory as it goes,
//   and what it puts to the outbox goes the way an awaited run's words go (kind `gated`, the home DM's own person, the outbox decides). The next run sees it
//   with `marley.lane.list` and `marshal.tool.recall`. Only the tree of an awaited run (free time, the dream, the store watch) starts lanes: a fired routine's
//   sends carry a test slot or the server's withheld delivery that a lane's would not keep.
// - `marley.lane.list`: the brand's recent lanes with their state and final message.
// A fork task that names `breaks` (a move's book id or the run's ref) is a breaker: a fresh session whose brief is the move and its grounds, under the breaker's
// contract (try to break it in the data; end with a VERDICT line). Its verdict is kept under the top run's session, and free time marks an ask checked only on a
// breaker's held verdict for that move, never on the run's own word (2026-11-20, from the free-time sim's verdict: a self-graded second look passed a wrong move).
// No count, size, time or budget cap (Omer R15, 2026-11-19: "my standing preference is to reduce guards, not overload them"; R143/R144). What stays: a caller
// must be a running session of this brand (brand scope comes from the server), and a lane speaks only where its top run may (AGENTS.md: no message to a person
// without authorization; tests and delegated agents count).
import { randomUUID } from "node:crypto";

import type { AgentLaunchRequest, SessionRecord, SessionStore } from "@zygstinct/marshal-sdk-port";

import type { Logger } from "../logger.js";
import type { ConversationKey } from "../store.js";

/** How a session settled (the port's `onSettled` outcome; the package does not export its type). */
export type SessionOutcome = { state: "idle"; reply?: string } | { state: "failed"; error: string };

/** The session label that marks a fork or a lane of a routine run (`fork` | `lane`), set by the server at launch. */
export const DELEGATION_LABEL = "delegation";
/** The session that started the fork or lane. */
export const DELEGATED_FROM_LABEL = "delegatedFrom";
/** The lane's brief as the run wrote it, for `marley.lane.list`. */
export const LANE_BRIEF_LABEL = "laneBrief";

/** How many of the brand's newest lanes `marley.lane.list` returns (a page of the list, not a refusal). */
const LANES_LISTED = 10;
/** A session title is one line: the name is shortened to fit it (the brief itself is never cut). */
const TITLE_LENGTH = 80;
/** Lane endings kept in this process; older ones are read from the session transcript. */
const LANE_ENDINGS_KEPT = 200;
/** Ended awaited runs whose context this process keeps for a breaker the server starts after the run (`breakAfter`); bookkeeping, not a limit on breakers. */
const ENDED_RUNS_KEPT = 200;

/** Labels a child never inherits: the automation of its parent (its end must not move the parent's `after` chain) and the parent's own delegation marks. */
const NOT_INHERITED = new Set(["automation", DELEGATION_LABEL, DELEGATED_FROM_LABEL, LANE_BRIEF_LABEL]);

export type DelegationKind = "fork" | "lane";

/** A session running on the sandbox now, as the engine opened it: what a fork or lane of it inherits. */
export interface RunContext {
  brandId: string;
  routineId: string;
  /** The run's home conversation: a child runs as the same chat user in the same work folder. */
  home: ConversationKey;
  /** Whose data grant the run holds (routine-engine.ts runMember), undefined when the run binds none. */
  runMember?: string;
  /** `run`: a fired routine (its sends carry a test slot or the server's delivery); `gated`: an awaited run (free time); or a fork or lane. */
  kind: "run" | "gated" | DelegationKind;
  /** For a fork or lane: the kind of the top run it descends from. A lane speaks as that run does, so only a `gated` run's tree starts lanes. */
  origin?: "run" | "gated";
}

interface Child extends RunContext {
  kind: DelegationKind;
  origin: "run" | "gated";
  sessionId: string;
  parentId: string;
  name: string;
  outcome?: SessionOutcome;
  waiters: ((outcome: SessionOutcome) => void)[];
}

export interface ForkAnswer {
  name: string;
  sessionId: string;
  state: "idle" | "failed";
  answer?: string;
  error?: string;
  /** A breaker's verdict, read from its answer's last VERDICT line. */
  verdict?: BreakerVerdict["verdict"];
}

/** What a breaker fork concluded about one move: `held` (it could not break it), `partly` (part of it fell) or `broken`; `none` when its answer gave no verdict. */
export interface BreakerVerdict {
  move: string;
  verdict: "held" | "partly" | "broken" | "none";
  name: string;
  sessionId: string;
  /** The breaker's answer (its objections and what it checked). */
  answer: string;
  /** On partly: what the person may be told, cut by the breaker to what it could not break, with what is still untested (its STANDS line). */
  stands?: string;
}

/**
 * The verdict of a breaker's answer: the word right after the label of its last line that starts with VERDICT (the contract's format, "VERDICT: held"). Only
 * that word counts: "VERDICT: held, nothing in it broken" is held, never broken because a later word says so.
 */
export function verdictOf(answer: string): BreakerVerdict["verdict"] {
  const lines = answer.split("\n").map((line) => line.replace(/[*_`#>]/g, "").trim()).filter((line) => /^verdict\b/i.test(line));
  const word = /^verdict\s*[:=\-–—]?\s*([a-z]+)/i.exec(lines[lines.length - 1] ?? "")?.[1]?.toLowerCase();
  return word === "held" || word === "partly" || word === "broken" ? word : "none";
}

const STANDS_LENGTH = 1200;

/**
 * The breaker's STANDS line on a partly verdict: the text after the label of its last line that starts with STANDS (the contract's format, "STANDS: ...").
 * Undefined when there is none or it is empty.
 */
export function standsOf(answer: string): string | undefined {
  const lines = answer.split("\n").map((line) => line.replace(/[*_`#>]/g, "").trim()).filter((line) => /^stands\b/i.test(line));
  const text = /^stands\s*[:=\-–—]?\s*(.*)$/i.exec(lines[lines.length - 1] ?? "")?.[1]?.trim();
  return text ? text.slice(0, STANDS_LENGTH) : undefined;
}

export interface LaneSummary {
  laneId: string;
  name: string;
  brief: string;
  state: string;
  startedAt: string;
  updatedAt: string;
  startedBy: string;
  finalMessage?: string;
}

export interface RoutineDelegationDeps {
  launch(request: AgentLaunchRequest): void;
  session(sessionId: string): SessionRecord | undefined;
  store(): Pick<SessionStore, "list" | "messages">;
  abort(sessionId: string): void;
  logger: Logger;
}

const refused = (message: string) => Object.assign(new Error(message), { code: "refused" });

const FORK_CONTRACT = (routineId: string) =>
  `You are a fork of this brand's ${routineId} run. The run handed you the part below and is waiting for your answer. You have the run's data tools, guides and memory. You have no send tool and nothing you put to the outbox is read: your final message is the only thing that goes back, to the run, never to a person. Do the part completely, file what should outlast it as the run would (marshal.tool.remember, brand memory linked to what it is about), and end with what you found, the numbers with their dates, what you filed and what is still open. You may split independent parts of it with marley.fork.run.`;

const BREAKER_CONTRACT = (routineId: string) =>
  `You are a breaker: a fork of this brand's ${routineId} run with a fresh mind. The run found a move and wants to put it to a person; your one job is to break it in the data before anyone acts on it. You did not build it, so do not defend it. You have the run's data tools, guides and memory and no send tool; your final message goes back to the run only.
Go through these, each on the data itself, not on the run's summary. Where knowledge.search (the question in words) finds a recipe of this brand that answers a point, run it first; read raw rows for what no recipe covers. Run the queries that do not depend on each other together in one TypeScript block, not one after another:
1. What is each key number really? Read sample raw rows behind it: what the label means in the data (a discount's type: an automatic sitewide discount or a code; returning orders: subscription renewals or people who chose to buy again; an ad with no orders: a dead ad, or one whose link carries no tracking id, so check the platform's own purchase count beside the shop's).
2. Is the data complete for the dates and channels it uses? Which channels have spend in the tables for those dates, and does it match the total cost the books show (a P&L or invoice line)? A missing channel or month turns a cost into a fake low.
3. What is the base rate? A share or a lift means nothing until it is set against the same number for everything else ("89% were new customers": what share of all orders are new?).
4. Twelve months back: the same metric over the last year. When was it different, and what changed then?
5. Size: is the money range plausible against the brand's totals (what it applies to: all sales, or only the part the move touches)?
6. Does a second source agree (the ad platform beside the shop, the P&L beside the orders, another table)?
Then the strongest objection that survives, in one or two sentences, and what would settle it.
On partly, write one line before the verdict that starts with STANDS: the finding as the person may be told it, cut to only what you could not break, with its numbers, their window and data date, the move it still supports for that person to decide (when one does: what to change, and the cheapest test), and in plain words what is still untested (a cause nobody checked is said as a question, never as fact; an estimate you derived is said as an estimate, "likely about"); no claim that fell. The server tells the person that line instead of the run's words, so it must stand on its own.
End with exactly one last line: VERDICT: held (you tried and could not break it), VERDICT: partly (name what fell and what still stands) or VERDICT: broken (why).`;

const LANE_CONTRACT = (routineId: string) =>
  `You are a lane: a background run for this brand that its ${routineId} run started. Nobody waits for you and nobody reads your final message live, so what you find reaches people only through what you file. File each finding as you go with marshal.tool.remember (brand memory, linked to what it is about); a move is a "decision" memory linked to the member who acts on it ({personId}). The next free-time run reads your state and final message with marley.lane.list and your memories with marshal.tool.recall. Something a person should hear now goes to the outbox the way any run's words go, and the outbox decides whether it reaches them. You may split independent parts with marley.fork.run and start another lane with marley.lane.start. End with a short summary: what you looked at, what you found and filed, and what to look at next.`;

/** The text a fork's or lane's session gets as its first message: the server's contract, then the brief the run wrote. */
export function delegatedTask(kind: DelegationKind, routineId: string, brief: string, breaks?: string): string {
  if (kind === "fork" && breaks) return `${BREAKER_CONTRACT(routineId)}\n\nThe move and its grounds, as the run wrote them:\n${brief}`;
  return `${kind === "fork" ? FORK_CONTRACT(routineId) : LANE_CONTRACT(routineId)}\n\nThe ${kind === "fork" ? "part" : "lane's brief"}, as the run wrote it:\n${brief}`;
}

function textOf(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw refused(`${field} must be a non-empty string`);
  return value.trim();
}

const nameOf = (name: string | undefined, brief: string): string => (name ?? brief.split("\n")[0]!).replace(/\s+/g, " ").trim().slice(0, TITLE_LENGTH) || "Part";

/** The kind of the top run a session descends from. */
const originOf = (context: RunContext): "run" | "gated" => context.origin ?? (context.kind === "gated" ? "gated" : "run");

export class RoutineDelegations {
  /** Sessions running on the sandbox now, by session id: a fork or lane call is accepted only from one of them. */
  private readonly running = new Map<string, RunContext>();
  /** Every fork and lane this process launched and has not forgotten, by session id. */
  private readonly children = new Map<string, Child>();
  /** The final message (or failure) of lanes that ended in this process, newest LANE_ENDINGS_KEPT; older ones are read from the session transcript. */
  private readonly laneEndings = new Map<string, string>();
  /** Breakers' verdicts by the top run's session id, until that run's gate takes them (`takeVerdicts`). */
  private readonly verdicts = new Map<string, BreakerVerdict[]>();
  /** The context of awaited runs that ended, newest ENDED_RUNS_KEPT: the gate may still start a breaker for their ask (`breakAfter`). */
  private readonly ended = new Map<string, RunContext>();

  constructor(private readonly deps: RoutineDelegationDeps) {}

  /** A session's sandbox opened: it may now fork and, in an awaited run's tree, start lanes. */
  enter(sessionId: string, context: RunContext): void {
    this.running.set(sessionId, context);
  }

  /** A session's sandbox closed. Its forks are parts of it, so an unfinished one is stopped; its lanes go on. */
  leave(sessionId: string): void {
    const context = this.running.get(sessionId);
    if (context?.kind === "gated") {
      this.ended.set(sessionId, context);
      while (this.ended.size > ENDED_RUNS_KEPT) this.ended.delete(this.ended.keys().next().value!);
    }
    this.running.delete(sessionId);
    for (const child of this.children.values()) {
      if (child.kind === "fork" && child.parentId === sessionId && !child.outcome) this.deps.abort(child.sessionId);
    }
  }

  /** The fork or lane a session is, when this process launched it. */
  of(sessionId: string): (RunContext & { kind: DelegationKind; origin: "run" | "gated"; parentId: string }) | undefined {
    return this.children.get(sessionId);
  }

  /** A session settled. Returns true when it was a fork or lane of this process (its waiters get the outcome). */
  settled(sessionId: string, outcome: SessionOutcome): boolean {
    const child = this.children.get(sessionId);
    if (!child) return false;
    if (child.outcome) return true;
    child.outcome = outcome;
    // The map holds what runs; a settled lane stays listable from the session store, and a fork's waiter keeps its own reference.
    this.children.delete(sessionId);
    if (child.kind === "lane") {
      const ending = outcome.state === "idle" ? outcome.reply : `failed: ${outcome.error}`;
      if (ending) {
        this.laneEndings.set(sessionId, ending);
        while (this.laneEndings.size > LANE_ENDINGS_KEPT) this.laneEndings.delete(this.laneEndings.keys().next().value!);
      }
    }
    for (const waiter of child.waiters.splice(0)) waiter(outcome);
    this.deps.logger.info(`routine_engine.${child.kind}_settled`, { brandId: child.brandId, routineId: child.routineId, sessionId, parentId: child.parentId, state: outcome.state });
    return true;
  }

  private launchChild(kind: DelegationKind, caller: string, context: RunContext, brief: string, name: string, breaks?: string): Child {
    const parent = this.deps.session(caller);
    if (!parent) throw refused("the calling run is not a session of this host");
    const sessionId = randomUUID();
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parent.labels ?? {})) if (!NOT_INHERITED.has(key)) labels[key] = value;
    labels[DELEGATION_LABEL] = kind;
    labels[DELEGATED_FROM_LABEL] = caller;
    if (kind === "lane") labels[LANE_BRIEF_LABEL] = brief;
    const child: Child = { ...context, origin: originOf(context), kind, sessionId, parentId: caller, name, waiters: [] };
    this.children.set(sessionId, child);
    try {
      this.deps.launch({
        sessionId,
        task: delegatedTask(kind, context.routineId, brief, breaks),
        idempotencyKey: `routine-${kind}:${sessionId}`,
        name,
        ...(parent.model ? { model: parent.model } : {}),
        ...(parent.reasoningEffort ? { reasoningEffort: parent.reasoningEffort } : {}),
        // The run's profile: the same packages, skills and built-in tools (its Marley layer comes with the copied prompt label).
        ...(parent.extensions ? { extensions: parent.extensions } : {}),
        ...(parent.skills ? { skills: parent.skills } : {}),
        ...(parent.nativeTools ? { nativeTools: parent.nativeTools } : {}),
        ...(parent.systemPromptAppend ? { systemPromptAppend: parent.systemPromptAppend } : {}),
        ...(parent.mcpServerNames ? { mcpServerNames: parent.mcpServerNames } : {}),
        // A fork is the run's subagent; a lane is a top-level session that records who started it and reports to nobody.
        ...(kind === "fork" ? { parentId: caller } : { launchedBy: caller }),
        from: { kind: "session", sessionId: caller, name: parent.title },
        labels,
      });
    } catch (error) {
      this.children.delete(sessionId);
      throw error;
    }
    this.deps.logger.info(`routine_engine.${kind}_started`, { brandId: context.brandId, routineId: context.routineId, sessionId, parentId: caller });
    return child;
  }

  /** `marley.fork.run`: starts each part as a fork of the calling session and waits for all of them. */
  async fork(caller: string | undefined, brandId: string, input: Record<string, unknown>): Promise<{ forks: ForkAnswer[] }> {
    const context = caller ? this.running.get(caller) : undefined;
    if (!caller || !context || context.brandId !== brandId) throw refused("marley.fork.run answers only inside a running routine run of this brand");
    const tasks = input.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw refused("tasks must hold at least one {task, name?}");
    const planned = tasks.map((entry, index) => {
      const task = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      const brief = textOf(task.task, `tasks[${index}].task`, true)!;
      const breaks = textOf(task.breaks, `tasks[${index}].breaks`, false);
      return { brief, breaks, name: nameOf(textOf(task.name, `tasks[${index}].name`, false), breaks ? `Breaker: ${breaks}` : brief) };
    });
    const root = this.rootOf(caller);
    const children = planned.map((part) => this.launchChild("fork", caller, context, part.brief, part.name, part.breaks));
    const answers = await Promise.all(children.map(async (child, index) => {
      const answer = await this.waitFor(child);
      const breaks = planned[index]!.breaks;
      if (!breaks) return answer;
      const verdict = answer.state === "idle" ? verdictOf(answer.answer ?? "") : "none";
      const list = this.verdicts.get(root) ?? [];
      const stands = verdict === "partly" ? standsOf(answer.answer ?? "") : undefined;
      list.push({ move: breaks, verdict, name: child.name, sessionId: child.sessionId, answer: answer.answer ?? answer.error ?? "", ...(stands ? { stands } : {}) });
      this.verdicts.set(root, list);
      this.deps.logger.info("routine_engine.breaker_verdict", { brandId, routineId: context.routineId, runId: root, move: breaks, verdict, sessionId: child.sessionId });
      return { ...answer, verdict };
    }));
    return { forks: answers };
  }

  /** The top run a session belongs to: itself, or the run its fork chain descends from. */
  private rootOf(sessionId: string): string {
    let current = sessionId;
    for (let child = this.children.get(current); child; child = this.children.get(current)) current = child.parentId;
    return current;
  }

  /** The breakers' verdicts of a run (by its session id), taken once: the run's gate reads them when the run ends. */
  takeVerdicts(runSessionId: string): BreakerVerdict[] {
    const list = this.verdicts.get(runSessionId) ?? [];
    this.verdicts.delete(runSessionId);
    return list;
  }

  /**
   * A breaker the gate starts itself after an awaited run ended (2026-11-20, lane F): the run asked about a move no breaker of it looked at, so the check
   * happens anyway, on the brief the server built from its own record of the move, before anything reaches a person. It runs as a fork of that run (same
   * sandbox, home, profile and model) and resolves with its verdict. Null when this process no longer knows the run (a restart): the ask then stays unchecked.
   */
  async breakAfter(runSessionId: string, brandId: string, move: string, brief: string): Promise<BreakerVerdict | null> {
    const context = this.ended.get(runSessionId);
    if (!context || context.brandId !== brandId) return null;
    const child = this.launchChild("fork", runSessionId, context, brief, nameOf(undefined, `Breaker: ${move}`), move);
    const answer = await this.waitFor(child);
    const verdict = answer.state === "idle" ? verdictOf(answer.answer ?? "") : "none";
    this.deps.logger.info("routine_engine.breaker_verdict", { brandId, routineId: context.routineId, runId: runSessionId, move, verdict, sessionId: child.sessionId, by: "server" });
    const stands = verdict === "partly" ? standsOf(answer.answer ?? "") : undefined;
    return { move, verdict, name: child.name, sessionId: child.sessionId, answer: answer.answer ?? answer.error ?? "", ...(stands ? { stands } : {}) };
  }

  private waitFor(child: Child): Promise<ForkAnswer> {
    const answer = (outcome: SessionOutcome): ForkAnswer => {
      const base = { name: child.name, sessionId: child.sessionId, state: outcome.state };
      if (outcome.state === "failed") return { ...base, error: outcome.error };
      const reply = outcome.reply ?? this.lastAssistant(child.sessionId);
      return { ...base, answer: reply ?? "(the fork ended without a final message)" };
    };
    if (child.outcome) return Promise.resolve(answer(child.outcome));
    return new Promise((resolve) => child.waiters.push((outcome) => resolve(answer(outcome))));
  }

  private lastAssistant(sessionId: string): string | undefined {
    const messages = this.deps.store().messages(sessionId, 20);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant" && message.content.trim()) return message.content;
    }
    return undefined;
  }

  /** `marley.lane.start`: one standalone background run for the brand; returns at once with its id. */
  lane(caller: string | undefined, brandId: string, input: Record<string, unknown>): { laneId: string; name: string } {
    const context = caller ? this.running.get(caller) : undefined;
    if (!caller || !context || context.brandId !== brandId) throw refused("marley.lane.start answers only inside a running routine run of this brand");
    // A lane speaks with its top run's authority and no more (AGENTS.md: no message to a person without authorization): its sends go as `gated` (the home DM's
    // own person). Only an awaited run (free time, the dream, the store watch) speaks that way itself; a fired routine's sends carry a test slot or a withheld
    // delivery that the lane's could not keep, so its tree starts none.
    if (originOf(context) !== "gated") throw refused("marley.lane.start works only in free time (an awaited run): this routine's words go out under the server's own delivery rules, which a lane would not keep. Split the work with marley.fork.run, or do it here");
    const brief = textOf(input.task, "task", true)!;
    const name = nameOf(textOf(input.name, "name", false), brief);
    const child = this.launchChild("lane", caller, context, brief, name);
    return { laneId: child.sessionId, name };
  }

  /** `marley.lane.list`: the brand's newest lanes, running or ended, from the host's session store. */
  lanes(brandId: string): { lanes: LaneSummary[] } {
    const store = this.deps.store();
    const lanes = store.list({ labels: { brand: brandId, [DELEGATION_LABEL]: "lane" } })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LANES_LISTED)
      .map((session) => {
        const finalMessage = session.state === "running" ? undefined : (this.laneEndings.get(session.id) ?? this.lastAssistant(session.id));
        return {
          laneId: session.id,
          name: session.title,
          brief: session.labels[LANE_BRIEF_LABEL] ?? "",
          state: session.state,
          startedAt: session.createdAt,
          updatedAt: session.updatedAt,
          startedBy: session.labels[DELEGATED_FROM_LABEL] ?? session.launchedBy ?? "",
          ...(finalMessage ? { finalMessage } : {}),
        };
      });
    return { lanes };
  }
}
