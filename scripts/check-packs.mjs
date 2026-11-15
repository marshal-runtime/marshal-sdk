// Fails when the SDK's vendored Marshal runtime packs drift from a Marshal desktop's pins:
//
//   npm run check:packs -- --desktop <desktop checkout> [--ref origin/main]
//
// Without --desktop it checks the SDK alone (package.json, vendor/packs and SOURCE.json agree) and, when
// MARSHAL_DESKTOP_DIR is set, against that checkout. --ref reads the desktop at a git ref instead of its
// working tree. To fix drift, re-vendor: node scripts/vendor-packs.mjs --from <desktop checkout> && pnpm install.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAgainstDesktop, checkSdkPins, readDesktopPins } from "../dist/src/pack-pins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const desktopRoot = flag("--desktop") ?? process.env.MARSHAL_DESKTOP_DIR;
const ref = flag("--ref");

const drift = checkSdkPins(root);
let against = "";
if (desktopRoot) {
  const desktop = readDesktopPins(path.resolve(desktopRoot), ref);
  against = ` and desktop ${desktop.commit}`;
  drift.push(...checkAgainstDesktop(root, desktop));
}
if (drift.length) {
  process.stderr.write(`Pack drift between the SDK${against}:\n${drift.map((item) => `  ${item.name}: ${item.problem}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Packs agree: the SDK${against}.\n`);
