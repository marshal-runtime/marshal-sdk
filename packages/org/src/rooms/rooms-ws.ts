import WebSocket from "ws";

import type { RoomsSocketFactory } from "./rooms-socket";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** The production socket: `ws` with a frame cap and no compression (frames are small JSON). */
export const createWsRoomsSocket: RoomsSocketFactory = (url) =>
  new WebSocket(url, {
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: 15_000,
  });
