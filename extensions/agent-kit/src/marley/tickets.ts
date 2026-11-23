// Extract of zygstinct apps/agent-server/src/tickets.ts at 7110e58c8: only MarleyTickets:declare.
import { request as httpsRequest } from "node:https";
import { knownTool } from "./brand-stack.js";
import type { Logger } from "./logger.js";

/**
 * Tickets for the team (Omer R6/R11/R12, 2026-11-21): anything that keeps Marley from doing its best for a brand (a missing connector, a bug, a missing
 * capability or permission, data it cannot debug) is filed by Marley itself, from a chat, a worker or a routine run (`marley.ticket.file`,
 * brand-host-capabilities.ts), straight onto the team's Linear board: no table of its own (Omer R12: "I don't want to expand db just for tickets"). The
 * server adds the brand, who asked and the run from the calling session's own labels, never from the input. Only fields the server writes reach the
 * board (kind, a listed tool or area, routine, brand, requester and run ids): the model's title and detail stay in the run's own transcript, which the
 * issue names (privacy review P1 of PR #2072: a member's chat text and an owner's figures never reach Linear). A tool's name reaches the board only when
 * it is on the stack map (knownTool) or a member stated it through marley.stack.set (the server's own filing); any other is "unlisted tool" there and in
 * the logs, its name kept in agent.db and the run (privacy re-review N1/N3). The issue carries a dedupe marker on a typed key, never the model's wording:
 * a missing connector merges on its tool across brands and runs (one tool is one problem; a later brand becomes a comment, and an issue the team closed
 * or archived is a decision nothing files again, delivery review D1/R3); anything else is one issue per run (the run's transcript is what the team
 * opens, so two runs are two problems and a closed one never swallows a later one, delivery re-review R1). A repeat from a brand already on an open
 * issue writes nothing. At most NEW_ISSUES_PER_DAY new issues a UTC day; a slot comes back only when the board provably did not take the create
 * (BoardRefused, SD02). The Linear key lives only on the agent server (LINEAR_API_KEY), never on a brand VM.
 */
export const TICKET_KINDS = ["missing_connector", "bug", "missing_capability", "permission", "cant_debug_data", "other"] as const;

export type TicketKind = (typeof TICKET_KINDS)[number];

/** What a ticket with no tool is about, chosen by the model from this list (a typed field, LN01): the issue's subject, and part of its per-run key. */
export const TICKET_AREAS = ["connection", "data", "report", "routine", "media", "voice", "browser", "memory", "messaging", "other"] as const;

export type TicketArea = (typeof TICKET_AREAS)[number];

/** New issues the server opens on the board in one UTC day, all brands together (LN06 row G-T-ticket-new-per-day); a join or a repeat is not new. */
export const NEW_ISSUES_PER_DAY = 25;

/**
 * Linear returns an issue's comments 100 at a time; the board reads every page, so a turn or a brand already on the issue is never unseen (zyg-agents on
 * 1a618ee4e: one page made a long run's retry add its turn comment again; a cap on turns instead dropped a run's later problem, rules LN03 on d31d1b7d5).
 * Past this many pages (a size limit, LN04) the read fails, so the filing is a typed board-unavailable, logged, never a guess.
 */
export const COMMENT_PAGES = 50;

export interface TicketRequester {
  /** `member:<id>` (a person's chat or a worker on their behalf), `marley:<role>` (a routine, a group or a run with no person), or `connector_request`. */
  requester: string;
  /** The calling Marshal session (the run), or `turn:<id>` for a connector request. */
  run?: string;
  /** The routine whose run filed it (the session's `routine` label): part of a toolless ticket's key and subject. */
  routine?: string;
  /**
   * The turn of the run that filed it (a member's chat session runs many turns and days): a later turn's filing on its run's open issue is a comment
   * naming that turn, so the team sees each turn's transcript and one recurring problem opens one issue (zyg-agents on 7e4df8bc5 and 60da2ede8).
   */
  turn?: string;
  /**
   * Set by the server only, never from input: the tool's name is one a member stated through marley.stack.set (the stack's `member_said`), so it may go
   * on the board even when the stack map does not know it (privacy re-review N1).
   */
  toolStated?: true;
}

/**
 * The board provably did not take a create: nothing was sent (team or label lookup failed), or Linear refused it before acting (a 4xx other than a
 * timeout, a GraphQL error with no data, `success: false`). Only this gives the day's slot back; any other failure is an unknown outcome (SD02).
 */
export class BoardRefused extends Error {
  override readonly name = "BoardRefused";
}

/** An issue on the board found by its dedupe marker, with the brands already on it (from the brand markers in its description and comments). */
export interface BoardIssue {
  id: string;
  identifier: string;
  brands: string[];
  /** The title after the brand prefix (`<Kind>: <title>`), from the issue's current title or else the server's `marley-title:` line; null when neither has one. */
  subject: string | null;
  /** The turns already on it (`marley-turn:` lines of its description and comments). */
  turns?: string[];
  /**
   * The team closed it (done or declined) or archived it: for a missing connector a decision for every brand, so it is not filed again (delivery review
   * D1, R3); for anything else a later run's filing opens a new issue.
   */
  closed: boolean;
}

/** The team's board. Linear in production (`linearBoard`); a fake in tests, the simulator and the local stack. */
export interface TicketBoard {
  find(marker: string): Promise<BoardIssue | null>;
  create(issue: { title: string; description: string }): Promise<BoardIssue>;
  comment(issueId: string, body: string): Promise<void>;
  /** Replaces the issue's title (the brand prefix grows when another brand joins). */
  retitle(issueId: string, title: string): Promise<void>;
}

export type FileResult =
  | { ok: true; ticket: string; repeat: boolean; brands: number; decided?: true }
  | { ok: false; reason: "invalid" | "no-board" | "board-unavailable" | "daily-cap"; message: string };

const SUBJECT_MARKER = "marley-title:";

/** The turns named by turn markers in an issue's text (a grammar the server writes, read back). */
export const turnsIn = (text: string): string[] => [...text.matchAll(/^marley-turn: ([A-Za-z0-9:_-]{1,100})$/gm)].map((match) => match[1]!);

/** The brands named by brand markers in an issue's text (a grammar the server writes, read back). */
export const brandsIn = (text: string): string[] => [...text.matchAll(/marley-brand: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].map((match) => match[1]!);

/**
 * Linear stores a domain-like word of a description or comment as a markdown link, `Judge.me` as `[Judge.me](<http://Judge.me>)` (MLY-785, 2026-11-22).
 * The server writes no links (scrubTicketText removes them), so a link whose text is its own address is that autolink and goes back to the word.
 */
export const withoutAutolinks = (text: string): string =>
  text.replace(/\[([^\]\n]{1,200})\]\(<?(https?:\/\/[^\s)>]{1,300})>?\)/g, (link, label: string, url: string) => {
    const bare = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
    return bare(url) === bare(label) ? label : link;
  });

/** The subject line the server wrote into an issue's description (its last `marley-title:` line), Linear's autolinks undone, or null. */
export const subjectIn = (description: string): string | null => {
  const lines = description.split("\n").filter((line) => line.startsWith(`${SUBJECT_MARKER} `));
  return lines.length ? withoutAutolinks(lines[lines.length - 1]!.slice(SUBJECT_MARKER.length + 1)) : null;
};

/** The subject of an issue title the server made (`[<brands>] <subject>`: brand labels carry no brackets), autolinks undone; null for another shape. */
export const subjectOfTitle = (title: string | null | undefined): string | null => {
  const match = /^\[[^\]\n]*\] (.+)$/.exec(title ?? "");
  return match ? withoutAutolinks(match[1]!) : null;
};

/** What a found issue's retitle keeps after the brand prefix: its current title's subject (Linear does not rewrite titles), else the description's line. */
const subjectOf = (issue: { title?: string | null; description?: string | null }): string | null => subjectOfTitle(issue.title) ?? subjectIn(issue.description ?? "");

export declare class MarleyTickets {
  private readonly now;
  /** Per marker, the filing in flight: two filings of one problem never race to create two issues. */
private readonly inFlight;
  private readonly ticketedCache;
  /** New issues opened this UTC day (in memory: a restart starts the count again, so the cap bounds a loop, not an exact day). */
private opened;
  private readonly deps;
  constructor(deps: { board: TicketBoard | null; logger: Logger; now?: () => number; onFiled?: (brandId: string) => void; brandName?: (brandId: string) => Promise<string | null> });
  /** Whether an issue of this key is one problem for every brand (a missing connector of one tool), so a closed one is the team's decision for all. */
static acrossRuns(input: { kind: TicketKind; tool?: string | null }): boolean;
  /**
   * The dedupe key, typed fields only, never the model's wording: a missing connector merges on its tool across brands and runs; anything else is keyed
   * on its run too, so two runs' problems are two issues even in one area (delivery re-review R1), and one run files one open issue per kind and area:
   * a later turn's filing on it is a comment naming that turn (fileOnBoard), so a recurring problem never spends the day's cap again (zyg-agents on
   * 60da2ede8). A filing with no run (none of today's paths) keys on its area and routine. Brand is never in it.
   */
static keyOf(input: { kind: TicketKind; tool?: string | null; area?: TicketArea | null; routine?: string | null; run?: string | null }): string;
  /**
   * The subject after the brand prefix, from server fields only: `<Kind>: <tool>` (`<tool> connector` for a missing connector), where a tool the board
   * may not name is "unlisted tool", else `<Kind>: <area>` and its routine.
   */
static subjectOf(input: { kind: TicketKind; tool: string | null; shown?: string | null; area: TicketArea; routine?: string | null }): string;
  static markerOf(key: string): string;
  file(brandId: string, who: TicketRequester, raw: unknown): Promise<FileResult>;
  private fileOnBoard;
  private namesOf;
  private remember;
  /**
   * Whether this brand is on the board's missing-connector issue for a tool, so the server does not file it again. A board read is cached (a hit for
   * 6 h, a miss for 10 min) and bounded (2.5 s): a slow or failed read is `unknown` (logged, not cached), never a guessed no.
   */
ticketed(brandId: string, tool: string): Promise<boolean | "unknown">;
}

/** The board's settings: present only when the agent server holds LINEAR_API_KEY (Secret Manager `marley-linear-api-key`, never a brand VM). */
export interface LinearBoardConfig {
  apiKey: string;
  /** The team's key (MLY, Marley's board). */
  team: string;
  /** The label every issue Marley files carries. */
  label: string;
}

type Post = (body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

type CommentPage = { nodes: { body: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null };

const postLinear: Post = (body, headers) => new Promise((resolve, reject) => {
  const req = httpsRequest({ method: "POST", host: "api.linear.app", path: "/graphql", headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 15_000 }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 512_000) chunks.push(chunk); else res.destroy(new Error("linear answer too large")); });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("linear request timed out")));
  req.on("error", reject);
  req.end(body);
});

/** The team's Linear board: issues of one team with one label, found by the marker in their description. */
export function linearBoard(config: LinearBoardConfig, post: Post = postLinear, logger?: Logger): TicketBoard {
  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const answer = await post(JSON.stringify({ query, variables }), { authorization: config.apiKey });
    // A 4xx is Linear refusing the request before acting on it, except a timeout (408) or a closed client (499), which say nothing about the effect.
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 499) throw new BoardRefused(`linear answered ${answer.status}`);
    if (answer.status !== 200) throw new Error(`linear answered ${answer.status}`);
    const parsed = JSON.parse(answer.body) as { data?: T | null; errors?: { message?: string }[] };
    const reason = (parsed.errors?.[0]?.message ?? "no data").slice(0, 120);
    // Errors with no data at all: nothing ran. Errors beside some data: a part may have run, so the outcome is unknown.
    if (!parsed.data) throw new BoardRefused(`linear refused: ${reason}`);
    if (parsed.errors?.length) throw new Error(`linear answered with errors: ${reason}`);
    return parsed.data;
  };
  let team: Promise<string> | null = null;
  const teamId = () => {
    team ??= (async () => {
      const teams = await gql<{ teams: { nodes: { id: string }[] } }>("query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }", { key: config.team });
      const id = teams.teams.nodes[0]?.id;
      if (!id) throw new Error(`linear has no team ${config.team}`);
      return id;
    })().catch((error) => { team = null; throw error; });
    return team;
  };
  // The label is found, or created on the team; when neither works the issue is filed without it (logged) rather than not at all, and the next filing tries again.
  let label: string | null = null;
  const labelId = async (team: string): Promise<string | null> => {
    if (label) return label;
    try {
      const labels = await gql<{ issueLabels: { nodes: { id: string; team: { id: string } | null }[] } }>("query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id team { id } } } }", { name: config.label });
      const found = labels.issueLabels.nodes.find((node) => node.team === null || node.team.id === team);
      if (found) return (label = found.id);
      const created = await gql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>("mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }", { input: { name: config.label, teamId: team } });
      if (!created.issueLabelCreate.success || !created.issueLabelCreate.issueLabel) throw new Error("linear did not create the label");
      return (label = created.issueLabelCreate.issueLabel.id);
    } catch (error) {
      logger?.warn("ticket.label_unavailable", { label: config.label, message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      return null;
    }
  };
  return {
    async find(marker) {
      // Every state, archived ones too: a closed issue is the team's decision (delivery review D1). An open issue with the marker wins over a closed one.
      // An archived issue counts as closed whatever its state (delivery re-review R3): the team took it off every view, so a brand joining it would be
      // seen by nobody, and Marley does not undo a triage choice by unarchiving.
      const data = await gql<{ issues: { nodes: { id: string; identifier: string; title?: string | null; description: string | null; archivedAt?: string | null; state?: { type?: string | null } | null; comments: CommentPage }[] } }>(
        `query($team: String!, $marker: String!) { issues(first: 5, includeArchived: true, filter: { team: { key: { eq: $team } }, description: { contains: $marker } }) { nodes { id identifier title description archivedAt state { type } comments(first: 100) { nodes { body } pageInfo { hasNextPage endCursor } } } } }`,
        { team: config.team, marker },
      );
      const matching = data.issues.nodes.filter((node) => node.description?.includes(marker));
      const closed = (node: { archivedAt?: string | null; state?: { type?: string | null } | null }) => Boolean(node.archivedAt) || node.state?.type === "completed" || node.state?.type === "canceled";
      const issue = matching.find((node) => !closed(node)) ?? matching[0];
      if (!issue) return null;
      const bodies = issue.comments.nodes.map((comment) => comment.body);
      let page = issue.comments.pageInfo;
      for (let pages = 1; page?.hasNextPage; pages += 1) {
        if (pages >= COMMENT_PAGES) throw new Error(`linear issue ${issue.identifier} has more comments than the board reads (${COMMENT_PAGES} pages)`);
        if (!page.endCursor) throw new Error(`linear gave no cursor for the next comment page of ${issue.identifier}`);
        const more = await gql<{ issue: { comments: CommentPage } | null }>(
          "query($id: String!, $after: String!) { issue(id: $id) { comments(first: 100, after: $after) { nodes { body } pageInfo { hasNextPage endCursor } } } }",
          { id: issue.id, after: page.endCursor },
        );
        if (!more.issue) throw new Error(`linear lost issue ${issue.identifier} while reading its comments`);
        bodies.push(...more.issue.comments.nodes.map((comment) => comment.body));
        page = more.issue.comments.pageInfo;
      }
      const brands = [...new Set([issue.description ?? "", ...bodies].flatMap(brandsIn))];
      const turns = [...new Set([issue.description ?? "", ...bodies].flatMap(turnsIn))];
      return { id: issue.id, identifier: issue.identifier, brands, subject: subjectOf(issue), closed: closed(issue), turns };
    },
    async create(issue) {
      let team: string;
      let labelIds: string | null;
      try {
        team = await teamId();
        labelIds = await labelId(team);
      } catch (error) {
        // Nothing was sent to create the issue yet: a provable non-acceptance whatever went wrong.
        throw new BoardRefused(`no create was sent: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
      }
      const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } | null } }>(
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }",
        { input: { teamId: team, title: issue.title, description: issue.description, ...(labelIds ? { labelIds: [labelIds] } : {}) } },
      );
      if (!data.issueCreate.success) throw new BoardRefused("linear did not create the issue");
      if (!data.issueCreate.issue) throw new Error("linear answered success with no issue");
      return { id: data.issueCreate.issue.id, identifier: data.issueCreate.issue.identifier, brands: brandsIn(issue.description), subject: subjectIn(issue.description), closed: false, turns: turnsIn(issue.description) };
    },
    async retitle(issueId, title) {
      const data = await gql<{ issueUpdate: { success: boolean } }>("mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issueId, input: { title } });
      if (!data.issueUpdate.success) throw new Error("linear did not update the title");
    },
    async comment(issueId, body) {
      const data = await gql<{ commentCreate: { success: boolean } }>("mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId, body } });
      if (!data.commentCreate.success) throw new Error("linear did not add the comment");
    },
  };
}
