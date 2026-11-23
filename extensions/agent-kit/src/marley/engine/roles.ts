import { z } from "zod";

// Adapted from zyg-agents src/runner/engine/roles.ts. A role is what a session runs on: its model and effort. It carries no text: an agent's
// prompt is built from the persona's layers (prompt.ts, tasks/worker-prompt.ts), and how Marley sounds is the outbox composer's (docs/design/marley-model.md).
// A role sets no limit: no turn cap, budget or time cap (Omer R143).

const RoleSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  /** How hard the model thinks before it answers; set, it turns on adaptive thinking at that effort. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

/** A role: the model and effort a session runs on. */
export type Role = z.infer<typeof RoleSchema>;

/** An agent profile's model and effort (an extension manifest's `contributes.agents[].profile`) as a role. Throws on a profile without a model. */
export function roleFromProfile(name: string, profile: { model?: unknown; effort?: unknown }): Role {
  return RoleSchema.parse({ name, model: profile.model, ...(profile.effort === undefined ? {} : { effort: profile.effort }) });
}
