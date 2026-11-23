import { SANDBOX_SERVICE, serviceToken } from "../contracts.js";
import { createDaytonaSandbox, DAYTONA_HOST_SERVICE, type DaytonaHost } from "../sandboxes/daytona.js";

interface ActivationContext {
  services: { get<T>(token: symbol): T };
}

/** Binds the kit's Daytona `Sandbox` as the host's sandbox (`bind`: one per host; another sandbox extension replaces it). */
export function activate(context: ActivationContext) {
  const host = context.services.get<DaytonaHost>(serviceToken(DAYTONA_HOST_SERVICE));
  return {
    serviceContributions: [{ token: serviceToken(SANDBOX_SERVICE), mode: "bind" as const, binding: { useValue: createDaytonaSandbox(host) } }],
  };
}
