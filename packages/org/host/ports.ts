// The SDK host's side of the org package: where org state lives, how org files are encrypted, how a run chat is
// imported. The desktop answers the same questions with app-paths, safeStorage and its session importer; an SDK host
// answers them through configureOrgHost(). The person's org token itself comes from the host (connectOrg's
// token/tokenFile), never from a separate credential.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ClaudeTranscriptImport,
  ClaudeTranscriptImportResult,
  FirstPartyExtensionCatalogEntry,
  SessionImportTarget,
} from "./types";

/** Encrypts and decrypts org state files (token store, outboxes, share links). */
export interface OrgFileCipher {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(ciphertext: Buffer): Buffer;
}

export interface OrgHostPorts {
  /** Root of org state (token store, outboxes, replicas). Default: MARSHAL_SDK_HOME or ~/.marshal-sdk. */
  stateDir?: string;
  /**
   * Encryption of org state files. Default: AES-256-GCM with a 32-byte key kept in `<stateDir>/org-state.key`
   * (mode 0600). `null` writes plaintext, as the desktop does when safeStorage is unavailable.
   */
  cipher?: OrgFileCipher | null;
  /** The bundled first-party extension catalog the org admission check compares against. Default: none. */
  firstPartyExtensionCatalog?: readonly FirstPartyExtensionCatalogEntry[];
  /** Imports a cloud run's Claude transcript as a local session (org run chats). Default: not supported here. */
  importClaudeTranscript?: (target: SessionImportTarget, input: ClaudeTranscriptImport) => Promise<ClaudeTranscriptImportResult>;
}

let ports: OrgHostPorts = {};
let cachedKey: Buffer | null | undefined;

export function configureOrgHost(next: OrgHostPorts): void {
  ports = { ...ports, ...next };
  cachedKey = undefined;
  FIRST_PARTY_EXTENSION_CATALOG.length = 0;
  FIRST_PARTY_EXTENSION_CATALOG.push(...(ports.firstPartyExtensionCatalog ?? []));
}

export const FIRST_PARTY_EXTENSION_CATALOG: FirstPartyExtensionCatalogEntry[] = [];

export function getAppDataDir(): string {
  const dir = ports.stateDir ?? process.env.MARSHAL_SDK_HOME?.trim() ?? path.join(os.homedir(), ".marshal-sdk");
  return path.resolve(dir || path.join(os.homedir(), ".marshal-sdk"));
}

const MAGIC = Buffer.from("MSDKorg1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function defaultCipher(): OrgFileCipher | null {
  const key = loadOrCreateKey();
  if (!key) return null;
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(ciphertext) {
      const iv = ciphertext.subarray(0, IV_LENGTH);
      const tag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
    },
  };
}

function activeCipher(): OrgFileCipher | null {
  if (ports.cipher !== undefined) return ports.cipher;
  return defaultCipher();
}

/** The desktop asserts safeStorage is ready before touching encrypted files; an SDK host is always ready. */
export function assertSafeStorageReady(_op: string): void {}

/** A non-null value means org files are encrypted. With a host cipher this is a marker, not the key. */
export function loadOrCreateKey(): Buffer | null {
  if (ports.cipher === null) return null;
  if (ports.cipher) return Buffer.alloc(32);
  if (cachedKey !== undefined) return cachedKey;
  const keyPath = path.join(getAppDataDir(), "org-state.key");
  try {
    cachedKey = fs.readFileSync(keyPath);
    if (cachedKey.length !== 32) throw new Error("bad key length");
  } catch {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    cachedKey = randomBytes(32);
    fs.writeFileSync(keyPath, cachedKey, { mode: 0o600 });
  }
  return cachedKey;
}

export async function writeEncryptedFile(filePath: string, content: string): Promise<void> {
  const cipher = activeCipher();
  const bytes = cipher ? Buffer.concat([MAGIC, cipher.encrypt(Buffer.from(content, "utf8"))]) : Buffer.from(content, "utf8");
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, bytes, { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

export async function readEncryptedFile(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return buf.toString("utf8");
  const cipher = activeCipher();
  if (!cipher) throw new Error("Encryption key unavailable");
  return cipher.decrypt(buf.subarray(MAGIC.length)).toString("utf8");
}

export async function importClaudeTranscript(
  target: SessionImportTarget,
  input: ClaudeTranscriptImport,
): Promise<ClaudeTranscriptImportResult> {
  if (!ports.importClaudeTranscript) {
    throw new Error("This host does not import run chats (configureOrgHost({ importClaudeTranscript })).");
  }
  return ports.importClaudeTranscript(target, input);
}

/** The runtime id the desktop records for sessions that ran on a Marshal SDK host. */
export const ORG_SDK_RUNTIME = "marshal-sdk";

export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty";
  if (trimmed.startsWith(".")) return "Name cannot start with a dot";
  if (/[/\\:]/.test(trimmed)) return "Name cannot contain slashes or colons";
  if (["__proto__", "prototype", "constructor"].includes(trimmed.toLowerCase())) {
    return "Name is reserved";
  }
  if (trimmed.length > 100) return "Name is too long";
  return null;
}

export function isHiddenInternalControlMessage(message: { internalControl?: { side?: string; kind?: string } }): boolean {
  const control = message.internalControl;
  return (
    control !== undefined &&
    (control.side === "request" ||
      control.kind === "goal-continuation-composer" ||
      control.kind === "goal-transition-review" ||
      control.kind === "relay-progress")
  );
}
