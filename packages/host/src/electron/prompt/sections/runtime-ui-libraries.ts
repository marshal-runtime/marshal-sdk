import { MARSHAL_UI_THEME_TOKENS } from "../../../common/runtime-ui-theme";

export const RUNTIME_UI_KIT_EXAMPLE = `import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Activity from "lucide-react/icons/activity";
import { Badge, Card, Grid, Stat, Table, chartColors, chartTheme } from "@marshal/ui-kit";
export default function View({ rows }: { rows: { name: string; value: number }[] }) {
  return (
    <Card title="Revenue" actions={<Badge tone="success"><Activity size={12} /> live</Badge>}>
      <Grid><Stat label="Total" value={rows.reduce((sum, row) => sum + row.value, 0)} /></Grid>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={rows}><XAxis dataKey="name" {...chartTheme.axis} /><YAxis {...chartTheme.axis} />
          <Tooltip {...chartTheme.tooltip} /><Bar dataKey="value" fill={chartColors[0]} radius={4} /></BarChart>
      </ResponsiveContainer>
      <Table columns={[{ key: "name", header: "Name", sortable: true }, { key: "value", header: "Value", numeric: true }]} rows={rows} />
    </Card>
  );
}`;

const COLOR_TOKENS = MARSHAL_UI_THEME_TOKENS.map((token) => token.name).join(", ");

/** Prompt text for the offline libraries, @marshal/ui-kit and theme tokens (runtimeShowUi and ui.compile views). */
export const RUNTIME_UI_LIBRARIES_GUIDANCE = `**Libraries and native look (offline, already bundled):** custom views may import \`recharts\`, \`lucide-react\`, \`date-fns\`, \`motion\` (\`motion/react\`), \`d3-scale\`, \`d3-shape\`, \`clsx\` and \`@marshal/ui-kit\`; anything else fails to compile, and there is no network. \`@marshal/ui-kit\` is Marshal's own accessible component kit: Button, IconButton, Card, Section, Stack, Row, Grid, Heading, Text, Badge, Tabs, Table (sortable), Stat, Progress, Input, Textarea, Select, Checkbox, Switch, Slider, Tooltip, Dialog, EmptyState, Callout, plus \`chartColors\`/\`chartTheme\` for recharts. Prefer it over hand-rolled controls so views match the app in light and dark. Style any custom markup with theme variables, never hard-coded colors: ${COLOR_TOKENS}, \`--radius\`, \`--font-sans\`, \`--font-mono\` (they switch live with the app theme). Import icons as \`lucide-react/icons/<kebab-name>\` and date-fns functions as \`date-fns/<fn>\`: the bare \`lucide-react\` barrel loads ~8,000 files and makes the compile take about 10 seconds.

\`\`\`tsx
${RUNTIME_UI_KIT_EXAMPLE}
\`\`\``;

export const RUNTIME_UI_LIBRARIES_TOOL_NOTE =
  "Custom tsx may import recharts, lucide-react (as `lucide-react/icons/<kebab-name>`), date-fns, motion/react, d3-scale, d3-shape, clsx and @marshal/ui-kit (Button, Card, Table, Tabs, Stat, Input, Select, Dialog, chartColors/chartTheme, ...); no other packages, no network. Style with theme variables (var(--card), var(--border), var(--chart-1)), never hard-coded colors.";
