import type { BrandContext } from "../directory.js";
import type { Viewer } from "../memory.js";
import { isMember } from "@zygstinct/shared";

/**
 * The creative-quadrants layer of Marley's system prompt: the spend/CPA quadrants report for Meta ads, when to run it, and how to
 * handle the target question (docs/design/creative-quadrants.md). The guide is in every
 * system prompt, but the report runs only on a turn whose host context carries creativeQuadrantsBlock's line, which the server
 * computes per turn. The runner, SKILL.md and the 30-day skip memory ship in skills/creative-quadrants; a VM without them makes the guide answer as usual.
 */
export const CREATIVE_QUADRANTS_GUIDE = `# Creative spend quadrants: which ads to scale, test or cut

A report that grades Meta ads against a target or the account average: which to scale, which to keep testing and which to cut. It makes three phone cards (summary and grouped list, spend against new-customer cost with confidence bands, CPM against new-customer cost) and a short text. It runs the skill on your machine, reads only this brand's own data, and never changes an ad.

- On a turn with the host line described next, questions about which ads to scale, keep testing or kill, or how the creatives compare on cost, get this report; every other Meta question is still answered from meta-insights \`latest\`, as the Meta insights section says. Questions about what sold (yesterday's sales, the ads that sold most, the sources) go to the owner reports.
- On such a turn, a request for the ads' quadrants or a quadrant chart of the ads is this report too, for the window asked: the last 7 days is \`--days 7\`. Its three cards are that chart, so you never draw one with the charts guide or chart.py, even when the report comes back without cards.
- You run it only on a turn whose host context has the "Creative quadrants:" line. The server adds that line in any active member's own direct chat with Meta Ads connected, because the report carries spend and new-customer cost. Without it in a direct chat, Meta Ads is not connected: you answer what you can and say Meta Ads needs connecting for this report. Before the first run in a conversation, read /opt/zygstinct/experience/skills/creative-quadrants/SKILL.md with your file tools; it holds the commands and the reading rules. If that file is not on your machine, answer from the brand recipes as usual and do not promise the report.
- Build the command from the request (window, campaign, confidence), and say the window and options you used in one line with the report.
- On \`needs_target\` the runner found no saved target and made no card. Ask the owner one short question, in the owner's language: the most they want to pay for a new customer, with the suggested value it returned, in the currency \`needs_target\` returned, which they can accept with a yes or replace with their own number. Send nothing else yet.
  - On a yes or a number: save it by calling the capability zs.ua.target_set with its value input set to <n> (the suggested value on a yes, their number otherwise), then rerun the report and send the cards. This is the only time you save a target.
  - On a skip (they decline, say they do not know, or the next message does not answer): rerun with \`--relative\`, send the cards and keep the runner's closing line that invites a target. Save nothing.
- The suggested value is only what \`needs_target\` returned, never one you work out. The runner remembers a skip for 30 days and goes straight to relative mode in that time, so after a skip you never ask again yourself.
- The figures you say are the report's own lines, each figure as the report writes it. A day that has not loaded is late, never zero.
- After a daily owner report or a Meta analysis answer on a turn with the line, you may offer it once. It is not part of those reports and has no schedule.`;

/**
 * The host-context line that lets this turn run the creative-quadrants report, or null. Only with the flag on, in a direct chat
 * of a member, pending included (by the server's member list, not the viewer's claimed role) whose brand has Meta Ads connected.
 */
export function creativeQuadrantsBlock(brand: BrandContext | null, viewer: Viewer): string | null {
  if (!brand || brand.membersUnreadable || viewer.kind !== "dm" || !viewer.memberId) return null;
  const member = brand.members.find((candidate) => candidate.id === viewer.memberId);
  if (!isMember(member)) return null;
  if (!brand.connections.some((connection) => connection.provider === "meta_ads" && connection.status === "connected")) return null;
  return "Creative quadrants: on for this turn. This is the person's own direct chat and Meta Ads is connected, so you may run the creative-quadrants report when the question calls for it.";
}
