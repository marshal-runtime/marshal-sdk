// Extract of zygstinct apps/agent-server/src/connect-ladder.ts at 7110e58c8: only ConnectOffers.
import { type ConnectorProvider } from "@zygstinct/shared";

export interface ConnectOffers {
  /** Public origin of the web app; links are `<webUrl>/connections?source=<provider>`. */
  webUrl: string;
  /** Sources the web app currently offers a tile for. */
  offered: readonly ConnectorProvider[];
}
