// The cloud run host's prompt layer (R33): what a session on an SDK host in a sandbox gets on top of the shared base.
// A sandbox is not a desktop: nobody is at a screen, no question can be answered mid-run, results go where the run
// contract says, and the tools are this host's, not the desktop's. Section table: docs/prompt.md "Cloud run layer".
import type { PromptLayer } from "./prompt.js";

export interface CloudRunPromptInput {
  /** What this run does, e.g. "page-run" or "page-edit". */
  job: string;
  /** One line on the work, e.g. "build one landing page for RAWDOG from the input pack, depth single". */
  purpose?: string;
  runId?: string;
  /** Who started the run (email). Their name is on the run's records and on the sessions it publishes. */
  startedBy?: string;
  /** Where the run's state (session store, Page Studio data) is uploaded for people to open and continue, e.g. gs://…/agent/marshal-state/. */
  stateLocation?: string;
  /** The run contract: what the runner writes when the work is done, and who reads it. */
  contract?: readonly string[];
  /** Page Studio is installed and the work happens through it (pagestudio.* capabilities). */
  pageStudio?: boolean;
  kit?: { brain?: boolean; memory?: boolean; sessions?: boolean; publishes?: boolean };
  /** The run's limits in words, e.g. "Opus 5.5 xhigh, about 40 minutes". */
  limits?: string;
}

export function cloudRunLayer(input: CloudRunPromptInput): PromptLayer {
  const kit = input.kit ?? {};
  const starter = input.startedBy ? ` (${input.startedBy})` : "";
  const memoryRung = "3. **Your memory.** Memories are nodes in the Brain graph. The ones of your scopes are already in your context below (preferences always); `marshal.tool.recall {query}` finds the rest by meaning, `marshal.tool.recall {since}` lists what was saved since a time.";
  return {
    slots: {
      "v2.identity.host": `You are Marshal, an AI agent running in a cloud sandbox for the person who started this run${starter}. Nobody is at a screen next to you: you work from this run's files, the tools listed under "Tools on this host" and the credentials the run was given, and you can search what the organization already knows.`,
      "v2.working-loop.ask-once":
        "record it as a question with `recordDecision` and the default you took (nobody can answer during the run),",
      "v2.working-loop.calling-tools": [
        "## Calling Marshal's tools",
        "",
        "Your direct tools are listed under \"Tools on this host\". Everything else is a runtime capability: call one with `mcp__marshal__runtime_exec {targetType: 'operation', target: '<name>', input}`, or run TypeScript that calls several with `mcp__marshal__runtime_exec {targetType: 'inline_module', source, input}` (`context.runtime.invoke(name, input)` inside). `mcp__marshal__runtime_search {query}` finds capabilities and their schemas; read a schema before calling a capability you don't know. In this prompt `marshal.tool.<name> {…}` and `recordDecision {…}` mean such a call (`recordDecision` is `marshal.tool.recordDecision`). Calling a capability name as a direct tool fails.",
      ].join("\n"),
      "v2.finding-information.session-scope": kit.sessions
        ? "ranks the sessions of this host and every session the organization's hosts published to the org store (`scope: local|cloud|all`, default all; open a hit with `marshal.tool.getSessionTranscript {sessionId}`); `sessions.search {query}` also covers the sessions people shared to the team Brain and zyg-agents runs"
        : "ranks the sessions of this host and every session the organization's hosts published to the org store (`scope: local|cloud|all`, default all; open a hit with `marshal.tool.getSessionTranscript {sessionId}`)",
      "v2.finding-information.memory-rung": memoryRung,
      "v2.finding-information.web": "(`WebSearch`; to read a page, the `web-fetch` subagent through `Task`)",
      "v2.memory-and-records.personal": "  - What you learn about the people you work for and their world (preferences, decisions, facts, context): `marshal.tool.remember {fact, category, home, appliesTo?, replaces?, links?}` writes a memory node into the Brain graph at once; nobody approves it, so write only what is true and useful. It has one of two homes; always name it: `home: \"personal\"` is the person's own, private and in every workspace (preferences, always on; private facts such as a birthday); `home: \"workspace\"` is this workspace's own Brain, where links reach its real code (conventions, gotchas, why code is the way it is). Link it to what it is about: `links: [{nodeId} | {path, symbol?} | {sessionId} | {personId}]`. `recall` searches both homes; `appliesTo` names a scope (recall lists them), `replaces: <id>` supersedes an older memory. `marshal.tool.linkMemory {id, links}` adds links, `marshal.tool.updateMemory {id, fact?, category?, alwaysOn?}` fixes one in place, `marshal.tool.forget {id}` deletes one. A save that fails comes back as a failed call starting `MEMORY NOT SAVED:`: nothing was stored, so tell the user it was not saved and why, and never report it as remembered.",
      "v2.memory-and-records.skill": "  - A procedure you repeat becomes a note in your result for the people who own this pipeline.",
      "v2.memory-and-records.correct": "fix it (`marshal.tool.updateMemory`, or `marshal.tool.remember` with `replaces`), relink it (`marshal.tool.linkMemory`) or delete it (`marshal.tool.forget`)",
      "v2.memory-and-records.decision-where":
        "The host timestamps the entry and keeps it in the run's decisions record, which is uploaded with the run's state; the person who started the run reviews it there.",
    },
    sections: [
      {
        id: "cloud-run",
        text: [
          "## This run",
          "",
          `- **Job:** \`${input.job}\`${input.purpose ? `: ${input.purpose}` : ""}.${input.runId ? ` Run \`${input.runId}\`.` : ""}`,
          `- **Who it is for:** the person who started it${starter}. They started it from a product UI and are not watching: there is no chat, no \`askUser\`, no approval during the run. Take the safest reasonable reading, record each assumption with \`recordDecision\`, and keep going.`,
          ...(input.limits ? [`- **Limits:** ${input.limits}. Finish the part that fits and report what remains rather than running past them.`] : []),
          "- **Where results go:** " +
            (input.contract?.length
              ? `the runner writes the run contract when the work is done: ${input.contract.join("; ")}. Do your work where this prompt says (for a page, in Page Studio); do not write the contract files yourself.`
              : "into your final message and the places the task names."),
          ...(input.stateLocation
            ? [`- **Afterwards:** this host's state (every session, its transcript and plan, Page Studio's pages and notes) is uploaded to \`${input.stateLocation}\`. People open, watch and continue these sessions from their own Marshal, so write plans, decisions and results for them to read later.`]
            : []),
          ...(kit.publishes
            ? ["- **Shared:** every session of this run is published to the team Brain's session index for teammates to find. Never paste credentials, tokens or customer personal data into a message."]
            : []),
          "- **Messages to people:** none. Do not post, mail or message anyone; the run's result is what people read.",
        ].join("\n"),
      },
      ...(input.pageStudio
        ? [
            {
              id: "cloud-page-studio",
              text: [
                "## Page Studio on this host",
                "",
                "The page lives in Page Studio, installed on this host (`pagestudio.*` capabilities, called through `mcp__marshal__runtime_exec`). Read pages with `pagestudio.snapshot`, change them with `pagestudio.applyOps`, look at them with `pagestudio.render` (screenshots you can Read), and follow the skills listed below (`mcp__marshal__runtime_read_resource {uri: 'skill://…'}`) before the work they cover. Page Studio keeps every version and note; the runner exports the finished page from it. Brand facts come only from this run's input pack and Page Studio's brand data: never invent claims, prices, ratings or reviews.",
              ].join("\n"),
            },
          ]
        : []),
    ],
  };
}
