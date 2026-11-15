/**
 * Marshal theme tokens exposed to sandboxed (agent-authored) UI. One source of
 * truth: the host stamps resolved values from these names, the sandbox
 * stylesheet is generated from the light/dark literals, and introspection
 * (`ui.surfaces.describe`) lists them. `src/features/runtime-ui/hostTheme.test.ts`
 * keeps the literals in sync with `src/index.css`.
 */

export interface MarshalUiThemeToken {
  /** CSS custom property available inside the sandbox. */
  readonly name: string;
  /** Host (renderer) CSS custom property the live value is read from. */
  readonly source: string;
  readonly role: string;
  readonly light: string;
  readonly dark: string;
}

const token = (
  name: string,
  role: string,
  light: string,
  dark: string,
  source: string = name,
): MarshalUiThemeToken => ({ name, source, role, light, dark });

export const MARSHAL_UI_THEME_TOKENS: readonly MarshalUiThemeToken[] = Object.freeze([
  token("--background", "page background", "hsl(240, 30%, 98%)", "hsl(240, 10%, 7%)"),
  token("--foreground", "default text", "hsl(240, 10%, 9%)", "hsl(240, 14%, 92%)"),
  token("--card", "card surface", "hsl(0, 0%, 100%)", "hsl(240, 9%, 11%)"),
  token("--card-foreground", "text on card", "hsl(240, 10%, 9%)", "hsl(240, 14%, 92%)"),
  token("--popover", "popover surface", "hsl(0, 0%, 100%)", "hsl(240, 9%, 11%)"),
  token("--popover-foreground", "text on popover", "hsl(240, 10%, 9%)", "hsl(240, 14%, 92%)"),
  token("--primary", "primary action fill", "hsl(240, 10%, 10%)", "hsl(240, 14%, 92%)"),
  token("--primary-foreground", "text on primary", "hsl(0, 0%, 100%)", "hsl(240, 10%, 8%)"),
  token("--secondary", "secondary fill", "hsl(240, 24%, 94%)", "hsl(240, 8%, 14%)"),
  token("--secondary-foreground", "text on secondary", "hsl(240, 10%, 9%)", "hsl(240, 14%, 92%)"),
  token("--muted", "muted surface", "hsl(240, 24%, 94%)", "hsl(240, 8%, 14%)"),
  token("--muted-foreground", "secondary text", "hsl(240, 10%, 42%)", "hsl(240, 5%, 58%)"),
  token("--accent", "hover/selected surface", "hsl(240, 26%, 92%)", "hsl(240, 8%, 16%)"),
  token("--accent-foreground", "text on accent", "hsl(240, 10%, 9%)", "hsl(240, 14%, 92%)"),
  token("--destructive", "destructive/danger", "hsl(0, 72%, 48%)", "hsl(0, 84%, 68%)"),
  token("--border", "borders and dividers", "hsl(240, 18%, 90%)", "hsl(240, 6%, 20%)"),
  token("--input", "form control border", "hsl(240, 18%, 90%)", "hsl(240, 6%, 22%)"),
  token("--ring", "focus ring / brand", "hsl(250, 66%, 52%)", "hsl(252, 92%, 76%)"),
  token("--chart-1", "chart series 1", "hsl(250, 66%, 52%)", "hsl(252, 92%, 76%)"),
  token("--chart-2", "chart series 2", "hsl(162, 78%, 30%)", "hsl(162, 60%, 45%)"),
  token("--chart-3", "chart series 3", "hsl(28, 88%, 45%)", "hsl(32, 95%, 65%)"),
  token("--chart-4", "chart series 4", "hsl(199, 89%, 42%)", "hsl(199, 89%, 62%)"),
  token("--chart-5", "chart series 5", "hsl(240, 5%, 45%)", "hsl(240, 5%, 58%)"),
  token("--success", "success", "hsl(162, 78%, 34%)", "hsl(158, 64%, 52%)", "--color-success"),
  token(
    "--success-fg",
    "success text",
    "hsl(162, 84%, 24%)",
    "hsl(158, 60%, 66%)",
    "--status-success-fg",
  ),
  token(
    "--success-bg",
    "success surface",
    "hsl(158, 60%, 97%)",
    "hsl(160, 30%, 12%)",
    "--status-success-bg",
  ),
  token(
    "--success-border",
    "success border",
    "hsl(158, 46%, 78%)",
    "hsl(158, 32%, 28%)",
    "--status-success-border",
  ),
  token("--warning", "warning", "hsl(38, 92%, 48%)", "hsl(38, 92%, 62%)", "--color-warning"),
  token(
    "--warning-fg",
    "warning text",
    "hsl(28, 88%, 32%)",
    "hsl(32, 92%, 74%)",
    "--status-warning-fg",
  ),
  token(
    "--warning-bg",
    "warning surface",
    "hsl(34, 100%, 97%)",
    "hsl(28, 42%, 13%)",
    "--status-warning-bg",
  ),
  token(
    "--warning-border",
    "warning border",
    "hsl(30, 90%, 82%)",
    "hsl(28, 52%, 32%)",
    "--status-warning-border",
  ),
  token("--info", "informational", "hsl(199, 89%, 42%)", "hsl(199, 89%, 66%)", "--color-info"),
  token(
    "--destructive-bg",
    "danger surface",
    "hsl(0, 86%, 97%)",
    "hsla(0, 84%, 71%, 0.15)",
    "--color-danger-bg",
  ),
  token("--link", "link text", "hsl(250, 66%, 50%)", "hsl(252, 92%, 79%)", "--color-link"),
  token(
    "--hover",
    "row/button hover surface",
    "hsl(240, 22%, 93%)",
    "hsl(240, 7%, 17%)",
    "--bg-hover",
  ),
]);

export interface MarshalUiStaticToken {
  readonly name: string;
  readonly value: string;
  readonly role: string;
}

/** Same in light and dark. Fonts are system stacks: the sandbox cannot load Geist (font-src data:). */
export const MARSHAL_UI_STATIC_TOKENS: readonly MarshalUiStaticToken[] = Object.freeze([
  {
    name: "--font-sans",
    value: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    role: "body font",
  },
  {
    name: "--font-mono",
    value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    role: "code font",
  },
  { name: "--radius", value: "0.75rem", role: "base corner radius" },
]);

/** MCP-Apps standard variable names, derived from the Marshal tokens so live updates flow through. */
export const MARSHAL_UI_STANDARD_ALIASES: readonly (readonly [string, string])[] = Object.freeze([
  ["--color-background-primary", "var(--background)"],
  ["--color-background-secondary", "var(--muted)"],
  ["--color-background-tertiary", "var(--accent)"],
  ["--color-text-primary", "var(--foreground)"],
  ["--color-text-secondary", "var(--muted-foreground)"],
  ["--color-text-danger", "var(--destructive)"],
  ["--color-text-success", "var(--success-fg)"],
  ["--color-text-warning", "var(--warning-fg)"],
  ["--color-text-info", "var(--info)"],
  ["--color-border-primary", "var(--border)"],
  ["--color-ring", "var(--ring)"],
  ["--border-radius-md", "calc(var(--radius) - 2px)"],
  ["--border-radius-lg", "var(--radius)"],
]);

export const MARSHAL_UI_THEME_TOKEN_NAMES: readonly string[] = Object.freeze([
  ...MARSHAL_UI_THEME_TOKENS.map((entry) => entry.name),
  ...MARSHAL_UI_STATIC_TOKENS.map((entry) => entry.name),
  ...MARSHAL_UI_STANDARD_ALIASES.map(([name]) => name),
]);

export type MarshalUiColorScheme = "light" | "dark";

export function marshalUiThemeTokenValues(
  scheme: MarshalUiColorScheme,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    MARSHAL_UI_THEME_TOKENS.map((entry) => [
      entry.name,
      scheme === "dark" ? entry.dark : entry.light,
    ]),
  );
}

/**
 * Sandbox base stylesheet: literal light values on `:root`, dark values under
 * `data-theme="dark"`, plus statics and MCP-Apps aliases. Host-resolved values
 * (user theme overrides) are layered on top as inline custom properties.
 */
export function renderMarshalUiThemeCss(): string {
  const block = (scheme: MarshalUiColorScheme) =>
    MARSHAL_UI_THEME_TOKENS.map(
      (entry) => `${entry.name}:${scheme === "dark" ? entry.dark : entry.light}`,
    ).join(";");
  const statics = MARSHAL_UI_STATIC_TOKENS.map((entry) => `${entry.name}:${entry.value}`).join(";");
  const aliases = MARSHAL_UI_STANDARD_ALIASES.map(([name, value]) => `${name}:${value}`).join(";");
  return (
    `:root{color-scheme:light;${block("light")};${statics};${aliases}}` +
    `:root[data-theme="dark"]{color-scheme:dark;${block("dark")}}`
  );
}
