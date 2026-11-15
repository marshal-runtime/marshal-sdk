import type { CapabilityProvider } from "@marshal/runtime";
import { createRuntimeAgentProvider as createPortableAgentProvider } from "@marshal/runtime/delegation";

import type { MarshalRuntimeAgentPort } from "./agent-orchestration";

// The runtime owns marshal.agent.* (names, schemas, permissions, input checks) so every host
// serves the same capabilities; the desktop registers its session manager as the port.
export {
  MARSHAL_RUNTIME_AGENT_SCHEMA,
  MARSHAL_RUNTIME_TRANSCRIPT_MESSAGE_SCHEMA,
} from "@marshal/runtime/delegation";

export function createRuntimeAgentProvider(port: MarshalRuntimeAgentPort): CapabilityProvider {
  return createPortableAgentProvider(port);
}
