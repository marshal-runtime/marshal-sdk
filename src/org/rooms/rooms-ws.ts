// Replaces electron/org/rooms/rooms-ws.ts (c75500b1b), which wrapped `ws`: the SDK uses Node 22's global WebSocket, so
// it adds no dependency. The lifted socket client wants the `.on(...)` shape; this adapts the browser-style events.
import type { RoomsSocketFactory, RoomsSocketLike } from "./rooms-socket.js";

type Listener = (...args: never[]) => void;

export const createNodeRoomsSocket: RoomsSocketFactory = (url) => {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error("This Node has no global WebSocket (Node 22 or later is needed for rooms).");
  const socket = new WebSocketCtor(url);
  const adapter: RoomsSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on(event: string, listener: Listener) {
      switch (event) {
        case "open":
          socket.addEventListener("open", () => (listener as () => void)());
          break;
        case "message":
          socket.addEventListener("message", (message) => (listener as (data: unknown) => void)(message.data));
          break;
        case "close":
          socket.addEventListener("close", (closed) => (listener as (code: number) => void)(closed.code));
          break;
        case "error":
          socket.addEventListener("error", () => (listener as (error: Error) => void)(new Error("socket error")));
          break;
      }
      return adapter;
    },
  } as RoomsSocketLike;
  return adapter;
};
