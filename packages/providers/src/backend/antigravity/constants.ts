/** Env lookup for Antigravity. Tests pass partial maps, not a full ProcessEnv. */
export type AntigravityProcessEnv = Record<string, string | undefined>;

/** The Python SDK the bridge drives (PyPI `google-antigravity`). */
export const ANTIGRAVITY_SDK_PACKAGE = "google-antigravity";
export const ANTIGRAVITY_SDK_VERSION = "0.1.24";
export const ANTIGRAVITY_PYTHON_VERSION = "3.12";
/** A prepared interpreter that already has the SDK installed; skips provisioning. */
export const ANTIGRAVITY_PYTHON_ENV = "MARSHAL_ANTIGRAVITY_PYTHON";

export const ANTIGRAVITY_DEFAULT_MODEL_ID = "gemini-4-hydrogen";
export const ANTIGRAVITY_PREFERRED_MODEL_IDS = [ANTIGRAVITY_DEFAULT_MODEL_ID] as const;
export const ANTIGRAVITY_ACCOUNT_IDENTITY_PREFIX = "antigravity";
export const ANTIGRAVITY_SESSION_CONFIG_TRACE_FILENAME = "m-antigravity-session-config-trace.jsonl";
export const ANTIGRAVITY_CREDENTIALS_FILENAME = "credentials.json";
export const ANTIGRAVITY_SERVICE_ACCOUNT_FILENAME = "service-account.json";
export const ANTIGRAVITY_DEFAULT_VERTEX_LOCATION = "global";

export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
export const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY";
export const GOOGLE_GENAI_USE_VERTEXAI_ENV = "GOOGLE_GENAI_USE_VERTEXAI";
export const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT";
export const GOOGLE_CLOUD_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION";
export const GOOGLE_APPLICATION_CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";

/** Built-in Antigravity tools that only read. */
export const ANTIGRAVITY_READ_TOOLS = new Set([
  "view_file",
  "list_directory",
  "find_file",
  "search_directory",
]);
export const ANTIGRAVITY_WRITE_TOOLS = new Set(["edit_file", "create_file"]);
export const ANTIGRAVITY_URL_TOOLS = new Set(["read_url_content", "search_web"]);
export const ANTIGRAVITY_SHELL_TOOL = "run_command";
/**
 * Built-in tools whose job Marshal owns (askUser, forkSubagents, automations),
 * kept out of a session on Marshal's tool surface like Claude's disabled tools.
 */
export const ANTIGRAVITY_MARSHAL_OWNED_TOOLS = ["ask_question", "invoke_subagent", "schedule"] as const;
