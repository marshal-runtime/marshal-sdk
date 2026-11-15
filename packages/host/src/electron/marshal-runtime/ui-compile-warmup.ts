import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ReactUiCompiler } from "@marshal/runtime/ui";

import { createLogger } from "../../common/marshal-logger";
import { createMarshalReactUiOptions } from "./ui-packages";

const log = createLogger("UiCompileWarmup");

/** Touches every vendor package so their shared vendor modules are built (and cached on disk) before a real view needs them. */
const WARMUP_SOURCE = `import { Bar, BarChart, ResponsiveContainer, XAxis } from "recharts";
import { Activity } from "lucide-react";
import { format } from "date-fns";
import { motion } from "motion/react";
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import clsx from "clsx";
import { Button, Card, Stat } from "@marshal/ui-kit";
export default function Warmup() {
  const path = line()([[0, scaleLinear().domain([0, 1]).range([0, 1])(0)]]);
  return (
    <Card title={clsx("warmup", format(new Date(0), "yyyy"))}>
      <motion.div animate={{ opacity: 1 }}>{String(path)}</motion.div>
      <Activity size={16} />
      <Stat label="a" value="1" />
      <Button>go</Button>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={[{ a: 1 }]}>
          <XAxis dataKey="a" />
          <Bar dataKey="a" />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
`;

/**
 * The first authored-UI compile in a process pays ~2s (esbuild service start,
 * cold package files); every later one ~0.4s. Compiling a throwaway view once,
 * off the critical path, moves that cost out of the first real view. It shares
 * the runtime's on-disk cache directory, so the vendor modules it builds are
 * the ones the real compiler loads. The result never reaches the runtime store.
 */
export async function warmUiCompiler(cacheDirectory?: string): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-ui-warmup-"));
  const started = performance.now();
  try {
    fs.writeFileSync(path.join(workspace, "warmup.tsx"), WARMUP_SOURCE);
    const compiler = new ReactUiCompiler({
      workspacePath: workspace,
      ...(cacheDirectory ? { cacheDirectory } : {}),
      ...createMarshalReactUiOptions(),
    });
    await compiler.compileWorkspace(
      { entryPath: "warmup.tsx", title: "warmup" },
      { principal: { id: "ui-compile-warmup", kind: "agent" } },
    );
    log.info(`UI compiler warmed in ${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    log.warn(`UI compiler warmup skipped (${error instanceof Error ? error.name : "error"})`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
