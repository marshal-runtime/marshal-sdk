// Extract of zygstinct apps/agent-server/src/browser-decide.ts at 7110e58c8: only BROWSER_DECIDE_PATH, DECIDE_MAX_BODY_BYTES.
/**
 * POST /zs/decide (docs/knowledge/browser-relay-20261105.md, "The VM browser's model"): the one model path of @marshal/browser on a brand VM.
 *
 * The browser asks its host's `marshal.models.decide` for every judgement (which element, is the goal done, does this page need a sign-in). A brand
 * VM has no model key and must never hold one, so the VM provider (apps/sandbox/runtime-bootstrap/zs-marshal-browser.mjs) forwards that call here over
 * the session's own model tunnel, and this server answers it with marshal-sdk's own decide service (`createDecideService`, vendored in
 * @zygstinct/marshal-sdk-port/models) on the server's OPENAI_API_KEY. Never a Claude subscription and never a provider call written here.
 *
 * Authority: an open proxy session of a brand (front or worker; public pages are read by both). The brand comes from the session, never the body.
 * The server picks the provider and model: a `model` or `provider` in the body is dropped. Input is bounded before anything is sent; images are
 * base64 data URLs only (a URL would let the page choose what the provider fetches). Calls are counted per brand and limited per minute.
 */

export const BROWSER_DECIDE_PATH = "/zs/decide";

/** The proxy reads at most this many body bytes (a decision with up to MAX_IMAGES screenshots). */
export const DECIDE_MAX_BODY_BYTES = 12 * 1024 * 1024;

const MAX_IMAGES = 4;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null) ?? "null");
