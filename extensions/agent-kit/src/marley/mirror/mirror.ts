// Extract of zygstinct apps/agent-server/src/mirror/mirror.ts at 7110e58c8: only BrandMirror, DivergedArchiveResult, MirrorVm.
/** What the mirror needs from a brand's machine: a command runner. `BrandVm` fits. */
export interface MirrorVm {
  run(command: string, options?: { stdin?: string | Buffer; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string; raw: Buffer }>;
}

export type MirrorResult =
  | { status: "skipped"; reason: "no_secret" | "bad_secret" }
  | { status: "unchanged" }
  | { status: "pushed"; commits: number; head: string }
  /** `vm_history`: the VM's main no longer contains the mirrored head (the VM repo was replaced or rewritten); `remote_rejected`: GitHub has commits the mirror does not. */
  | { status: "diverged"; kind: "vm_history" | "remote_rejected"; reason: string; vmHead: string; mirrorHead: string | null }
  | { status: "failed"; error: string };

/** What became of an archive of a VM history the mirror cannot follow: kept under `ref` in the server mirror and pushed to GitHub as `branch`, or the step that failed. */
export type DivergedArchiveResult =
  | { status: "archived"; vmHead: string; ref: string; branch: string }
  | { status: "failed"; step: "no_secret" | "bad_secret" | "vm_head" | "bundle" | "fetch" | "push" | "unexpected"; exitCode: number | null };

/**
 * Mirrors one brand's repo after a turn. Never throws. `archiveDiverged` keeps a VM history that no longer contains the mirrored head (MLY-580): the VM's
 * whole `main` is fetched into the server mirror under its own ref and pushed to the brand's GitHub repo as a dated side branch, never over `main`.
 */
export type BrandMirror = (brandId: string, vm: MirrorVm) => Promise<MirrorResult>;
