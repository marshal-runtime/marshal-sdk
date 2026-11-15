// The rooms client of packages/org on its own, bundled into dist/src/org-rooms.js: what the rooms route and the
// @marshal/org extension need, without the rest of the organization layer (the extension runs in the host's
// module loader, which provides only a fixed set of built-ins).
export * from "../packages/org/src/rooms/rooms-manager";
export * from "../packages/org/src/rooms/rooms-conversation";
export * from "../packages/org/src/rooms/rooms-schema";
export * from "../packages/org/src/rooms/rooms-socket";
export { addLogSink, type LogEntry } from "../packages/providers/src/common/marshal-logger";
