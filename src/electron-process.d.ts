// The provider layer is shared with the Marshal desktop, where Electron adds this to `process`; on an SDK host
// it is undefined and the providers fall back to installed packages.
declare namespace NodeJS {
  interface Process {
    resourcesPath?: string;
  }
}
