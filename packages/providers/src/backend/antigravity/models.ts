import type { ReasoningEffort } from "../../contract/host-types";
import type { RuntimeModelInfo } from "../runtime-contract";
import { ANTIGRAVITY_DEFAULT_MODEL_ID } from "./constants";

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Gemini text models the Antigravity harness runs (Vertex publisher models,
 * checked 2026-11-20). Any other model id a person types is passed through.
 */
const MODELS: readonly { id: string; name: string; featured?: boolean; contextWindow?: number }[] = [
  { id: ANTIGRAVITY_DEFAULT_MODEL_ID, name: "Gemini 4 Hydrogen", featured: true },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", featured: true },
  { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  { id: "gemini-4-neon", name: "Gemini 4 Neon" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro (preview)" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_048_576 },
];

export function antigravityModels(): RuntimeModelInfo[] {
  return MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.featured ? { featured: true } : {}),
    supportedContextTiers: ["default"],
    supportedReasoningEfforts: EFFORTS,
    capabilities: {
      supportsVision: true,
      supports: { vision: true, reasoningEffort: true },
      ...(model.contextWindow ? { limits: { max_context_window_tokens: model.contextWindow } } : {}),
    },
  }));
}
