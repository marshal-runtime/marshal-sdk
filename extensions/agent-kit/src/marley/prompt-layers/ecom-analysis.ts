/**
 * The ecom-analysis method guide (ported from Zyg's analysis know-how, MLY-173), inlined into the background worker's system prompt so every
 * analysis run has it without a file read: in the 2026-11-04 local OKOA runs the worker never opened the shipped SKILL.md the runtime layer
 * names. ECOM_ANALYSIS_GUIDE must equal packages/experience/skills/ecom-analysis/SKILL.md after its front matter (prompt-layers.test.ts checks
 * it): edit the skill file, then this constant. metrics.md and playbooks.md stay on the VM and are read on demand.
 */
export const ECOM_ANALYSIS_SKILL_PATH = "/opt/zygstinct/experience/skills/ecom-analysis";

export const ECOM_ANALYSIS_GUIDE = `# Answer the owner's question

Read \`metrics.md\` for a definition or ratio; read \`playbooks.md\` for a why, comparison or recommendation. These are methods, not evidence that a source exists. The current turn's audience and tool permissions still apply. Money, spend, CPA, ROAS, margins and reports stay in a team member's own direct chat; this guide grants no access or send permission. A background worker returns its result, never messages anyone.

1. Resolve the metric, period and slice they asked about. Keep their label throughout follow-ups; do not silently substitute a nearby metric. Definition-only questions need no query. If two meanings would materially change the answer, ask one short question (a worker puts it in the result).
2. For live figures, discover data with \`knowledge.search\` (the question in words: definitions, guides, recipes and tables come back together), then \`knowledge.context\` on the table card; read the returned columns, grain and freshness. No table names from this guide, memory or another brand. \`knowledge.search\` lists the recipes that fit the question with their parameters and exact call; run one with \`zs.data.run_recipe\` {recipe, params}. Follow the runtime guide's exact schemas and SQL engine/fallback rules. Never invent a missing tool or runner.
3. Use the turn's shop clock, last complete shop day and currency. A day comparison uses the same weekday last week, plus the previous seven complete days' average when all seven are covered. A seven-day window uses the seven complete days before it. State the dates. Never compare today's partial sales with a full day; use matching elapsed windows only if available, otherwise label today partial and use complete days for the diagnosis. Do not inherit a fixed timezone or calendar-week default.
4. Query both sides in this turn. Sum numerators and denominators before dividing, never average daily ratios. Check coverage and newest source date before treating an empty day as zero; a seven-day average divides by seven only when all seven days are covered. Before you call orders unattributed, or say an ad platform, its tags or the data lost a campaign or ad, search \`store tracking setup\` and read that card: the attribution source and the pixel's first session, the connected sources with their dates and the storefront tags. When a drop starts on one of its dates, check our own tracking first, and name it as the cause only when the check shows it (for example, the platform's own count held while our campaign or ad ids thinned out). A zero or missing denominator makes a ratio unavailable. An increase from zero has an absolute change, not a finite percentage. Rate changes use percentage points; relative changes use \`(current - baseline) / abs(baseline)\`.
5. Keep a receipt: exact period, source or recipe, metric basis, filters, currency and newest source date. A connector's sync time is not proof the queried dates landed. In a worker, put the real query evidence in the result schema; do not label a number verified from prose alone.
6. Say the finding first, then the two or three figures that explain it, one material caveat and the next useful check. Use business names, not ids, SQL or internal filenames. Explain inference as inference. Do not call a correlation a cause or an incomplete investigation a clean bill of health.

## Reuse the shipped work

- Daily sales/source report or restock/category report: read \`../owner-reports/SKILL.md\` and use its existing runner and audience rules. Do not make a second report or schedule.
- Meta campaigns, creatives, ROAS, CPA or budget moves: read \`../meta-insights/SKILL.md\`, run its \`latest\` path and check supporting evidence as that guide requires. Recommendations come from the Meta review, not a new ranking invented here. Preserve quiet, stale, waiting and missing states; none means “no issues.”
- Creative quadrants: only with the server-provided grant; read \`../creative-quadrants/SKILL.md\`. This skill does not enable it.
- Ads named in the answer (the top ad, the ads to scale or kill, the ad behind a figure), in the owner's own direct chat only: read \`../ad-creative/SKILL.md\` and run its runner for up to five of them, so the person gets each ad's picture next to the figures. A worker returns the files under \`artifacts\`; when the runner reports no picture, say in the finding that the picture is not reachable right now.
- An ad that spends and looks dead, or a kill or pause you are about to say: run the measurement health check first (below).
- A future runner is not installed merely because a PR mentions it. Discover it from the installed guide, or use currently available recipes. Do not guess commands.

## Dead, or measured wrong?

Before you call a spending ad dead or dying, say kill or pause about it, or pass on a kill line, run the measurement health check for
those ads: \`knowledge.search\` lists \`ad_measurement_health\` beside the kill list (and \`pixel_tracking_health\` for the pixel against the
store); run it with \`zs.data.run_recipe\`, \`end_date\` the last complete shop day. It separates a real decline from a tracking break or a
budget change. Only \`real_decline\` is an ad that sells less. \`tracking_break\`: the drop may be in the measurement, so name the source that
lost the sales and check it before any cut. When a row shows \`account_ad_ids_lost\` (the share of credited orders that name an ad,
\`account_id_share_recent\`, far below \`account_id_share_base\`), our attribution stopped naming ads on most orders (on our side, every ad loses
its credits at once): weigh that with the ad's own figures and the store tracking setup card (for when) before you put a drop on
the ad or its tags. \`same_name_ads\` above 0 means a same-named ad may be taking its credit. The evidence lists the possible causes
most supported first; none is proven. \`spend_changed\`: the budget moved more
than 2x, so give the cost per purchase of both windows (a scaled-up ad that got dearer is diminishing returns, a starved one sells less
because of its budget; a new ad with no baseline is just new) and do not say kill.
\`too_few_to_judge\`, \`unclear\` and \`not_landed\`: no verdict yet; give the figures and say so.

## Two worked shapes

“Why did sales drop yesterday?” → check coverage, retrieve net sales and orders for yesterday and the same weekday last week, compute AOV from totals, then inspect the largest mix changes. “Sales were down mainly with fewer orders; basket size was steady” is justified only by those returned figures. Missing sessions means traffic versus checkout conversion is still unknown.

“Is pROAS better than NC ROAS?” → explain forecast lifetime value versus realized new-customer sales. Do not query for a definition. If they want this brand's figures and no scored LTV source is found, say the forecast comparison is unavailable; never rename blended ROAS to pROAS.`;

const INTRO = `# Ecom analysis method (applies to every analysis brief)

Follow this method for every sales, ads, funnel or profit question in the brief. Its metrics.md and playbooks.md are in ${ECOM_ANALYSIS_SKILL_PATH}/ (read them with your file tools when the question needs a definition or a playbook). "../owner-reports/SKILL.md", "../meta-insights/SKILL.md" and "../creative-quadrants/SKILL.md" are the files of those names under /opt/zygstinct/experience/skills/. When an owner-report runner answers the question (the owner reports layer names it), run it instead of writing the query yourself.`;

/** The worker layer: the intro, then the guide without its own title. */
export const ECOM_ANALYSIS_LAYER = `${INTRO}\n\n${ECOM_ANALYSIS_GUIDE.replace(/^# .*\n+/, "")}`;
