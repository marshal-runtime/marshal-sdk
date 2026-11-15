// Electron's global type namespace, which shared contract types name; outside Electron it carries no members.
declare namespace Electron {
  type IpcMainInvokeEvent = any;
  type IpcMainEvent = any;
  type WebContents = any;
  type BrowserWindow = any;
  type Event = any;
}
declare module "*?raw" {
  const text: string;
  export default text;
}
declare namespace NodeJS {
  interface Process {
    resourcesPath: string;
  }
}
