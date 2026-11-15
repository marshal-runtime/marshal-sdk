// The provider layer and session engine are shared with the Marshal desktop, where Electron adds this to
// `process` as a string. On an SDK host it is undefined at runtime: the shared code reads it only on the
// packaged-app path (app.isPackaged) and otherwise falls back to installed packages. It is typed as Electron
// types it so the shared code checks the same way in both repositories.
declare namespace NodeJS {
  interface Process {
    resourcesPath: string;
  }
}
