// The Marshal runtime host both shells run: the desktop's electron/marshal-runtime, shared byte for byte
// (scripts/vendor-desktop-host.mjs). The desktop builds it inside Electron; here `electron` resolves to
// platform/electron.ts, configured with configureHostPlatform().
export { configureHostPlatform, type HostPlatform } from "./platform/electron";
export { MarshalRuntimeHost, MarshalRuntimeHostStartupError, type MarshalRuntimeHostOptions } from "./src/electron/marshal-runtime/host";
export { ProductionMarshalRuntimeApi } from "./src/electron/marshal-runtime/api";
export * from "./src/electron/marshal-runtime/contracts";
