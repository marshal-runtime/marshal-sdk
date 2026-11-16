// node backfill.cjs <gs://output-root> [--state gs://…/marshal-state] [--workflow page-edit] [--workspace pages] [--visibility team|public|restricted] [--dry-run]
import { backfillRun } from "./backfill";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const roots = args.filter((arg, index) => arg.startsWith("gs://") && args[index - 1] !== "--state");
if (!roots.length) {
  process.stderr.write("usage: backfill.cjs <gs://output-root>… [--state gs://…] [--workflow w] [--workspace w] [--visibility v] [--dry-run]\n");
  process.exit(2);
}
void (async () => {
  for (const root of roots) {
    const result = await backfillRun({
      root,
      ...(flag("state") ? { state: flag("state")! } : {}),
      ...(flag("workflow") ? { workflow: flag("workflow")! } : {}),
      ...(flag("workspace") ? { workspace: flag("workspace")! } : {}),
      ...(flag("visibility") ? { visibility: flag("visibility") as "team" } : {}),
      dryRun: args.includes("--dry-run"),
    });
    process.stdout.write(`${JSON.stringify({ root: result.root, runId: result.runId, wrote: result.wrote, artifacts: result.artifacts, sessions: result.sessions, workspace: result.manifest.workspace, workflow: result.manifest.workflow, visibility: result.manifest.visibility })}\n`);
  }
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
