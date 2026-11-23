# Source

Everything under `src/marley/` and `src/marley-packages/` is copied from zygstinct, unchanged, at the commit in `source.json`
(branch `release/combined-20261122`, the Outbox + Routines refactor integration branch). Paths are kept as they were under
`apps/agent-server/src` and `packages/*/src`.

- `copies`: whole files.
- `extracts`: only the named top-level declarations of a file plus what they reference in it (`tools/extract.mjs`). A
  `Name:declare` entry is a class the kit needs only as a type, emitted as a `declare class` (Store, SshRunner, BrandStack, ...:
  the server's own objects the host passes in).
- `packages`: files of zygstinct packages, behind the `@zygstinct/*` shims in `src/compat/`.
- `typeTrees`: the `.d.ts` surface of Marley's vendored SDK port (`packages/marshal-sdk-port`), which the copied code is typed
  against. At run time the port resolves to this repository's SDK (`src/compat/sdk-port*.ts`).

Re-copy from a newer Marley commit: `node tools/sync.mjs <commit>`, then `node tools/close.mjs` to pull in any declaration the
new code started to use, then `pnpm typecheck`. Nothing under `src/marley*` is edited by hand.
