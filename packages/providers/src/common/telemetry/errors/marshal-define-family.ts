import type { ErrorFamily } from "../../../../host/engine-host-types";

/**
 * Central constructor for persisted telemetry family names.
 *
 * Lives in its own module (rather than `./marshal-index`) so that family files can
 * import it without creating a circular dependency through `./marshal-index`.
 */
export const defineFamily = (name: string): ErrorFamily => name;
