// The organization layer one Marshal host carries: connect, publish, inbox and outbox, remote sessions, rooms,
// sharing, mentions, comments, cloud move, org extension and skill catalogs, routines. The same source the Marshal
// desktop vendors (packages/marshal-org); an SDK host sets its state root, file encryption and importers with
// configureOrgHost(). The person's org token is the host's to pass (R18: the run acts as the person who started it).
export { configureOrgHost, type OrgFileCipher, type OrgHostPorts } from "./host/ports";
export * from "./src/cloud-session-sanitizer";
export * from "./src/common/org-onboarding";
export * from "./src/common/org-onboarding-agent-defaults";
export * from "./src/common/org-onboarding-tools";
export * from "./src/common/org-principal";
export * from "./src/common/org-roles";
export * from "./src/common/org-skills";
export * from "./src/common/org-url";
export * from "./src/contract/org-types";
export * from "./src/org-agent-defaults";
export * from "./src/org-audit-analysis";
export * from "./src/org-broker-fetch";
export * from "./src/org-broker-session";
export * from "./src/org-cloud-move";
export * from "./src/org-cloud-move-store";
export * from "./src/org-cloud-sessions";
export * from "./src/org-cloud-stranded-store";
export * from "./src/org-comments";
export * from "./src/org-deep-link";
export * from "./src/org-errors";
export * from "./src/org-extension-admission";
export * from "./src/org-extension-catalog";
export * from "./src/org-extension-pack";
export * from "./src/org-fork";
export * from "./src/org-held-transcript";
export * from "./src/org-mention-context";
export * from "./src/org-mentions";
export * from "./src/org-message-outbox";
export * from "./src/org-onboarding";
export * from "./src/org-onboarding-archive";
export * from "./src/org-placement";
export * from "./src/org-projects";
export * from "./src/org-remote-send";
export * from "./src/org-remote-sessions";
export * from "./src/org-run-chats";
export * from "./src/org-service";
export * from "./src/org-session-audit";
export * from "./src/org-session-sharing";
export * from "./src/org-session-watcher";
export * from "./src/org-session-workspace-store";
export * from "./src/org-share-outbox";
export * from "./src/org-shared-context";
export * from "./src/org-shared-link-store";
export * from "./src/org-shared-rooms";
export * from "./src/org-shared-rooms-adapter";
export * from "./src/org-shared-session-reads";
export * from "./src/org-shared-sessions";
export * from "./src/org-shared-stream";
export * from "./src/org-skill-catalog";
export * from "./src/org-skill-pack";
export * from "./src/org-skill-stamp";
export * from "./src/org-slack-destinations";
export * from "./src/org-status-read";
export * from "./src/org-token-store";
export * from "./src/org-wip-bundle";
export * from "./src/org-wiring";
export * from "./src/org-workspace-links";
export * from "./src/org-workspace-routines";
export * from "./src/rooms/org-rooms-service";
export * from "./src/rooms/rooms-agent-tools";
export * from "./src/rooms/rooms-conversation";
export * from "./src/rooms/rooms-file-cache";
export * from "./src/rooms/rooms-manager";
export * from "./src/rooms/rooms-replica";
export * from "./src/rooms/rooms-schema";
export * from "./src/rooms/rooms-socket";
export * from "./src/rooms/rooms-text";
export * from "./src/rooms/rooms-text-base";
export * from "./src/rooms/rooms-upload";
export * from "./src/rooms/rooms-ws";
// Names more than one module exports: the classes win the plain name; the contract shapes keep theirs under an alias;
// the rooms layer's conversation helpers win over the older shared-rooms adapter (still reachable as `sharedRooms`).
export { OrgExtensionCatalog } from "./src/org-extension-catalog";
export type { OrgExtensionCatalog as OrgExtensionCatalogDocument } from "./src/common/org-onboarding";
export { OrgHeldTranscript } from "./src/org-held-transcript";
export type { OrgHeldTranscript as OrgHeldTranscriptData } from "./src/contract/org-types";
export {
  conversationRoomId,
  type ConversationMessageFields,
  type ConversationWriter,
} from "./src/rooms/rooms-conversation";
export * as sharedRooms from "./src/org-shared-rooms";
