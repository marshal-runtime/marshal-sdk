/**
 * What a background worker actually ran, read from the tool calls the server's own PreToolUse hook let through (tool name and input as the SDK
 * delivered them), never from the worker's final text: the recipes it ran (`zs.data.run_recipe` id, with parameters when called as an operation), the
 * skills and guides it opened, and the runtime capabilities it called, as an operation or inside an inline block (read from the block's
 * `call('name', …)` / `invoke('name', …)` calls). It is stored with the task result and becomes part of the task's graph node, so a later turn finds a task by what it ran.
 * Every value is re-validated against a strict pattern and capped; an input that does not fit is dropped, not repaired.
 */
export interface RanRecipe { id: string; params: Record<string, string> }
export interface RanSkill { name: string; files: string[] }
export interface RanCapability { name: string; calls: number }
export interface RanSummary { recipes: RanRecipe[]; skills: RanSkill[]; capabilities: RanCapability[] }

const MAX_RECIPES = 12;
const MAX_PARAMS = 8;
const MAX_SKILLS = 12;
const MAX_FILES = 6;
const MAX_CAPABILITIES = 24;
const RECIPE_ID = /^[a-z0-9][a-z0-9_.-]{0,79}(@[A-Za-z0-9._-]{1,20})?$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const PARAM_VALUE = /^[A-Za-z0-9 _.:@+/-]{1,60}$/;
const CAPABILITY = /^[A-Za-z0-9_.-]{1,80}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SKILL_FILE = /^[A-Za-z0-9._-]{1,60}\.md$/;
const SKILL_PATH = /\/opt\/zygstinct\/experience\/skills\/([a-z0-9][a-z0-9-]{0,59})\/([A-Za-z0-9._-]{1,60}\.md)/g;
const RUN_OPERATIONS = new Set(["zs.data.run_recipe"]);
const BLOCK_CALL = /\b(?:call|invoke)\(\s*['"`]([A-Za-z0-9_.-]{1,80})['"`]/g;
const BLOCK_RECIPE = /\brecipe\s*:\s*['"`]([a-z0-9][a-z0-9_.-]{0,79}(?:@[A-Za-z0-9._-]{1,20})?)['"`]/g;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export class RanLog {
  private readonly recipes = new Map<string, RanRecipe>();
  private readonly skills = new Map<string, Set<string>>();
  private readonly capabilities = new Map<string, number>();

  /** One call the gate allowed. Denied calls never reach here, so what is listed ran (or was attempted by the SDK past the gate). */
  observe(toolName: string, toolInput: unknown): void {
    const input = record(toolInput);
    if (toolName === "Read") this.skill(input.file_path);
    else if (toolName === "Bash") this.skill(input.command);
    else if (toolName.endsWith("runtime_exec") && input.targetType === "operation" && typeof input.target === "string" && CAPABILITY.test(input.target)) {
      this.capability(input.target);
      if (RUN_OPERATIONS.has(input.target)) this.recipe(record(input.input));
    } else if (toolName.endsWith("runtime_exec") && input.targetType === "inline_module" && typeof input.source === "string") {
      const source = input.source.slice(0, 20000);
      for (const match of source.matchAll(BLOCK_CALL)) if (CAPABILITY.test(match[1]!)) this.capability(match[1]!);
      if (/run_recipe/.test(source)) for (const match of source.matchAll(BLOCK_RECIPE)) this.recipe({ recipe: match[1] });
    }
  }

  private capability(name: string): void {
    if (this.capabilities.has(name) || this.capabilities.size < MAX_CAPABILITIES) this.capabilities.set(name, (this.capabilities.get(name) ?? 0) + 1);
  }

  private recipe(args: Record<string, unknown>): void {
    if (typeof args.recipe !== "string" || !RECIPE_ID.test(args.recipe)) return;
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(args.params)).slice(0, MAX_PARAMS)) {
      const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
      if (PARAM_KEY.test(key) && PARAM_VALUE.test(text)) params[key] = text;
    }
    const key = `${args.recipe}\n${JSON.stringify(params)}`;
    if (!this.recipes.has(key) && this.recipes.size < MAX_RECIPES) this.recipes.set(key, { id: args.recipe, params });
  }

  private skill(text: unknown): void {
    if (typeof text !== "string") return;
    for (const match of text.slice(0, 4000).matchAll(SKILL_PATH)) {
      const files = this.skills.get(match[1]!) ?? (this.skills.size < MAX_SKILLS ? new Set<string>() : null);
      if (files && files.size < MAX_FILES) { files.add(match[2]!); this.skills.set(match[1]!, files); }
    }
  }

  snapshot(): RanSummary {
    return {
      recipes: [...this.recipes.values()],
      skills: [...this.skills].map(([name, files]) => ({ name, files: [...files] })),
      capabilities: [...this.capabilities].map(([name, calls]) => ({ name, calls })),
    };
  }
}

/** A stored `ran` read defensively (the row is the server's own, but an older build wrote none and nothing here may throw). Null when nothing ran. */
export function parseRan(value: unknown): RanSummary | null {
  const raw = record(value);
  const list = (entry: unknown): unknown[] => (Array.isArray(entry) ? entry : []);
  const recipes = list(raw.recipes).slice(0, MAX_RECIPES).map((entry): RanRecipe | null => {
    const item = record(entry);
    if (typeof item.id !== "string" || !RECIPE_ID.test(item.id)) return null;
    const params = Object.fromEntries(Object.entries(record(item.params)).slice(0, MAX_PARAMS).filter(([key, text]) => PARAM_KEY.test(key) && typeof text === "string" && PARAM_VALUE.test(text))) as Record<string, string>;
    return { id: item.id, params };
  }).filter((entry): entry is RanRecipe => entry !== null);
  const skills = list(raw.skills).slice(0, MAX_SKILLS).map((entry): RanSkill | null => {
    const item = record(entry);
    if (typeof item.name !== "string" || !SKILL_NAME.test(item.name)) return null;
    return { name: item.name, files: list(item.files).filter((file): file is string => typeof file === "string" && SKILL_FILE.test(file)).slice(0, MAX_FILES) };
  }).filter((entry): entry is RanSkill => entry !== null);
  const capabilities = list(raw.capabilities).slice(0, MAX_CAPABILITIES).map((entry): RanCapability | null => {
    const item = record(entry);
    return typeof item.name === "string" && CAPABILITY.test(item.name) && Number.isSafeInteger(item.calls) && (item.calls as number) > 0 ? { name: item.name, calls: item.calls as number } : null;
  }).filter((entry): entry is RanCapability => entry !== null);
  return recipes.length || skills.length || capabilities.length ? { recipes, skills, capabilities } : null;
}
