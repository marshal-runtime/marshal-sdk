/**
 * The catalog of host UI placements. Placement ids and part ids are PUBLIC API:
 * extensions and user customizations reference them, so they are stable,
 * lower-case dot/kebab ids and every change is additive.
 *
 * To make a new region customizable: add an entry here (with its default parts
 * and context docs), then wrap the region in `<Placement id context>` and each
 * default part in `<PlacementPart id>` (see src/features/runtime-ui/placements).
 * `RUNTIME_UI_HOST_PLACEMENTS` and `ui.surfaces.describe` derive from this list.
 */

export type PlacementShape = "region" | "toolbar" | "list" | "row" | "menu";
export type PlacementCatalogMode = "augment" | "fallback" | "replace" | "edit";

export interface PlacementPartDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface PlacementDefinition {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly description: string;
  readonly shape: PlacementShape;
  readonly supportedModes: readonly PlacementCatalogMode[];
  /** Embedded sandboxed views allowed (false for per-row placements: they never create iframes). */
  readonly allowsViews: boolean;
  /** Stable, editable default parts, in default order. */
  readonly parts: readonly PlacementPartDefinition[];
  /** Documented context fields handed to contributions (`when`, item actions, dynamic values, views). */
  readonly context: Readonly<Record<string, string>>;
  readonly maxContributions?: number;
}

const SESSION_CONTEXT = Object.freeze({
  "session.id": "string — session id",
  "session.title": "string — display name",
  "session.status": '"idle" | "busy" | "unread"',
  "session.workspaceName": "string | undefined — registered workspace name",
  "session.isBusy": "boolean — a turn or subagent is running",
  "session.pinned": "boolean",
  "session.updatedAt": "string — ISO timestamp",
});

const ALL_MODES: readonly PlacementCatalogMode[] = ["augment", "fallback", "replace", "edit"];
const LIST_MODES: readonly PlacementCatalogMode[] = ["augment", "edit"];

function define(definition: PlacementDefinition): PlacementDefinition {
  return Object.freeze({
    ...definition,
    supportedModes: Object.freeze([...definition.supportedModes]),
    parts: Object.freeze(definition.parts.map((part) => Object.freeze({ ...part }))),
    context: Object.freeze({ ...definition.context }),
  });
}

export const PLACEMENT_CATALOG: readonly PlacementDefinition[] = Object.freeze([
  define({
    id: "nav.primary",
    parentId: "nav",
    title: "Primary navigation",
    description: "Main navigation entries (and extension applications) available without a chat.",
    shape: "list",
    supportedModes: LIST_MODES,
    allowsViews: true,
    parts: [
      { id: "new-chat", title: "New chat" },
      { id: "chat", title: "Chat", description: "Collapsed navigation only." },
      { id: "automations", title: "Routines" },
      { id: "create", title: "Workspaces" },
      { id: "activities", title: "Activity" },
      { id: "plugins", title: "Plugins" },
      { id: "integrations", title: "Integrations" },
    ],
    context: { compact: "boolean — the collapsed icon rail is showing" },
  }),
  define({
    id: "nav.sessions",
    parentId: "nav",
    title: "Chat list",
    description: "The whole chat list in the left navigation.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [
      { id: "header", title: "Threads header" },
      { id: "pinned", title: "Pinned chats" },
      { id: "threads", title: "Thread rows" },
      { id: "shared-with-me", title: "Shared with me group" },
      { id: "cloud", title: "Cloud chats group" },
      { id: "search", title: "Search field" },
      { id: "empty", title: "Empty state (no chats / no matches)" },
      { id: "paging", title: "Loading and load-more status" },
    ],
    context: { "search.query": "string — current chat search text" },
  }),
  define({
    id: "nav.sessions.header",
    parentId: "nav.sessions",
    title: "Chat list header",
    description: "Toolbar above the chat list.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "title", title: "Threads title" },
      { id: "filter", title: "Filter menu" },
    ],
    context: {},
  }),
  define({
    id: "nav.sessions.row",
    parentId: "nav.sessions",
    title: "Chat row",
    description: "Each chat in the list: badges, actions, and the default row parts.",
    shape: "row",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "nested-disclosure", title: "Nested agents toggle" },
      { id: "pin", title: "Pin button" },
      { id: "unread", title: "Unread dot" },
      { id: "running", title: "Running spinner" },
      { id: "cloud-indicator", title: "Cloud indicator" },
      { id: "source-icon", title: "Automation / subagent icon" },
      { id: "title", title: "Title" },
      { id: "subtitle", title: "Date under the title (search results)" },
      { id: "timestamp", title: "Timestamp" },
      { id: "overflow", title: "Overflow menu" },
    ],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "nav.sessions.row.menu",
    parentId: "nav.sessions.row",
    title: "Chat row menu",
    description: "Items in a chat row's overflow menu.",
    shape: "menu",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "rename", title: "Rename" },
      { id: "open-in-new-window", title: "Open in new window" },
      { id: "share", title: "Share with organization" },
      { id: "brain-share", title: "Share to team Brain" },
      { id: "cloud-move", title: "Move to or from cloud" },
      { id: "delete", title: "Delete" },
    ],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "nav.footer",
    parentId: "nav",
    title: "Navigation footer",
    description: "Bottom of the left navigation.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [{ id: "account-settings", title: "Account and settings" }],
    context: { compact: "boolean — the collapsed icon rail is showing" },
  }),
  define({
    id: "chat.header",
    parentId: "chat",
    title: "Chat header",
    description: "Header of every chat.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: true,
    parts: [{ id: "actions", title: "Header actions" }],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.sidepanel",
    parentId: "chat",
    title: "Chat side panel",
    description: "The in-chat activity side panel. Augment adds a tab; edits change tabs.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [
      { id: "progress", title: "Progress" },
      { id: "decisions", title: "Decisions" },
      { id: "goal", title: "Goal" },
      { id: "evidence", title: "Evidence" },
      { id: "agents", title: "Agents" },
      { id: "changes", title: "Workspace changes" },
      { id: "workspace", title: "Worktrees and branches" },
      { id: "health", title: "Health" },
    ],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.sidepanel.progress",
    parentId: "chat.sidepanel",
    title: "Progress section",
    description: "The progress section of the side panel.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [
      { id: "heading", title: "Section heading" },
      { id: "rows", title: "Todo rows" },
    ],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.sidepanel.progress.row",
    parentId: "chat.sidepanel.progress",
    title: "Progress row",
    description: "Each todo row in the progress section.",
    shape: "row",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "status-icon", title: "Status icon" },
      { id: "title", title: "Todo title" },
      { id: "status-badge", title: "Status badge" },
    ],
    context: {
      ...SESSION_CONTEXT,
      "todo.id": "string",
      "todo.label": "string",
      "todo.status": '"pending" | "in_progress" | "done" | "blocked"',
      "todo.index": "number — zero-based position",
    },
  }),
  define({
    id: "chat.sidepanel.goal",
    parentId: "chat.sidepanel",
    title: "Goal controls",
    description: "Goal row actions in the side panel.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "previous", title: "Previous goal" },
      { id: "position", title: "Goal position label" },
      { id: "next", title: "Next / latest goal" },
    ],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.message.actions",
    parentId: "chat",
    title: "Message actions",
    description: "Per-message actions.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [
      { id: "copy", title: "Copy" },
      { id: "retry", title: "Retry" },
    ],
    context: {
      ...SESSION_CONTEXT,
      "message.id": "string",
      "message.role": '"user" | "assistant"',
    },
  }),
  define({
    id: "chat.empty",
    parentId: "chat",
    title: "Empty chat",
    description: "The empty-chat state.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [{ id: "welcome", title: "Welcome" }],
    context: {},
  }),
  define({
    id: "chat.composer.actions",
    parentId: "chat.composer",
    title: "Chat composer actions",
    description: "Application buttons beside the chat input.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.composer.add",
    parentId: "chat.composer",
    title: "Chat composer add button",
    description: "The plus button. Augment with menu actions or replace it.",
    shape: "menu",
    supportedModes: ["augment", "fallback", "replace"],
    allowsViews: false,
    parts: [],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "chat.slash-command",
    parentId: "chat.composer",
    title: "Chat slash commands",
    description: "Composer `/` commands.",
    shape: "menu",
    supportedModes: ["augment", "fallback", "replace"],
    allowsViews: false,
    parts: [],
    context: SESSION_CONTEXT,
  }),
  define({
    id: "app.statusbar",
    parentId: "app",
    title: "Status bar",
    description: "A thin bottom strip. Renders nothing when empty.",
    shape: "toolbar",
    supportedModes: LIST_MODES,
    allowsViews: false,
    parts: [],
    context: {},
  }),
  define({
    id: "app.home",
    parentId: "app",
    title: "Home",
    description: "Home / landing.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: {},
  }),
  define({
    id: "settings.sections",
    parentId: "settings",
    title: "Settings sections",
    description: "Add a section to Settings.",
    shape: "list",
    supportedModes: LIST_MODES,
    allowsViews: true,
    parts: [
      { id: "about", title: "About" },
      { id: "general", title: "General" },
      { id: "ai", title: "AI & models" },
      { id: "access", title: "Access & devices" },
      { id: "system", title: "System" },
      { id: "labs", title: "Labs" },
      { id: "developer", title: "Developer" },
    ],
    context: {},
  }),
  define({
    id: "app.theme",
    parentId: "app",
    title: "Theme",
    description: "Theme token contributions (metadata marshal.ui.theme).",
    shape: "region",
    supportedModes: ["augment"],
    allowsViews: false,
    parts: [],
    context: {},
  }),
  define({
    id: "createPanel.primarySidebar",
    parentId: "createPanel",
    title: "Create: primary sidebar",
    description: "Left column: file tree, workspace switcher, navigation.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: {},
  }),
  define({
    id: "createPanel.contentHeader",
    parentId: "createPanel",
    title: "Create: content header",
    description: "Thin bar at the top of the main content column.",
    shape: "toolbar",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: {},
  }),
  define({
    id: "createPanel.editor",
    parentId: "createPanel",
    title: "Create: editor",
    description: "Main content area below the content header.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: {},
  }),
  define({
    id: "createPanel.secondarySidebar",
    parentId: "createPanel",
    title: "Create: secondary sidebar",
    description: "Right column: chat panel, secondary tools.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: {},
  }),
  define({
    id: "createPanel.treeNodeIcon",
    parentId: "createPanel.primarySidebar",
    title: "Create: tree node icon",
    description: "Icon next to a file node in the file tree.",
    shape: "row",
    supportedModes: ["augment", "replace"],
    allowsViews: false,
    parts: [],
    context: { fileExtension: "string — extension of the node, e.g. md" },
  }),
  define({
    id: "workflowsPanel.runDetail",
    parentId: "workflowsPanel",
    title: "Workflows: run detail",
    description: "Middle pane of the workflow run-detail page.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: { workflowId: "string" },
  }),
  define({
    id: "workflowsPanel.detailCommandCenter",
    parentId: "workflowsPanel",
    title: "Workflows: command center",
    description: "Expandable section on the workflow detail page.",
    shape: "region",
    supportedModes: ALL_MODES,
    allowsViews: true,
    parts: [],
    context: { workflowId: "string" },
  }),
]);

const CATALOG_BY_ID: ReadonlyMap<string, PlacementDefinition> = new Map(
  PLACEMENT_CATALOG.map((definition) => [definition.id, definition]),
);

export function getPlacementDefinition(id: string): PlacementDefinition | undefined {
  return CATALOG_BY_ID.get(id);
}

export function hasPlacementPart(placementId: string, partId: string): boolean {
  return CATALOG_BY_ID.get(placementId)?.parts.some((part) => part.id === partId) ?? false;
}

/** Plain-data description of the customization system for `ui.surfaces.describe`. */
export function describePlacementCatalog() {
  return {
    note: "Extensions customize host placements through application metadata. Register the application at a placement with action `augment` (items, edits, embedded views) or `replace`/`fallback` (whole-view replacement, only where supportedModes allows). camelCase ids register in lower-kebab form (createPanel.editor -> create-panel.editor).",
    contributionKinds: {
      view: 'metadata["marshal.ui.contribution"] absent or {kind:"view"}: embedded sandboxed view, only where allowsViews; receives the placement context as props, updated in place.',
      item: '{kind:"item", item:{type:"button"|"badge"|"link"|"menu-item"|"text", label, icon?, tooltip?, tone?, position?:{before|after: partId}, when?:{contextPath: value}, action?:{type:"capability"|"open"|"prompt"}, dynamic?:{capability, refreshMs?}}}: native control, no iframe.',
      edits:
        '{kind:"edits", edits:[{op:"hide"|"show"|"relabel"|"icon"|"tone"|"tooltip"|"move"|"order"|"when", placementId, part, ...}]}: edits to the default parts. Unknown placement/part is ignored with a diagnostic. Extension edits apply sorted by extension id, then the user\'s edits.',
    },
    icon: 'metadata["marshal.ui.icon"] = "lucide:<kebab-name>" | {resource: uri of a resource the extension publishes; svg/png/webp <= 64 KB}. Used for nav, composer actions, items and Settings.',
    theme:
      'metadata["marshal.ui.theme"] = {light?, dark?, density?} with allowlisted CSS tokens; registered at app.theme.',
    tones: ["neutral", "accent", "positive", "warning", "negative", "muted"],
    placements: PLACEMENT_CATALOG.map((definition) => ({
      id: definition.id,
      parentId: definition.parentId,
      title: definition.title,
      description: definition.description,
      shape: definition.shape,
      supportedModes: definition.supportedModes,
      allowsViews: definition.allowsViews,
      parts: definition.parts,
      context: definition.context,
      ...(definition.maxContributions ? { maxContributions: definition.maxContributions } : {}),
    })),
  };
}
