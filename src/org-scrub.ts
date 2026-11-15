// The desktop's cloud-session sanitizer (packages/org/src/cloud-session-sanitizer.ts) on its own, bundled into
// dist/src/org-scrub.js: secrets and local paths are scrubbed from everything an SDK host publishes to the org,
// the same way the desktop scrubs what it shares.
export { scrubText } from "../packages/org/src/cloud-session-sanitizer";
