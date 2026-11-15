import { describe, expect, it } from "vitest";

import { scrubText } from "./cloud-session-sanitizer";
import { streamableReplyText } from "./org-shared-stream";

const roots = { workspaceRoot: "/Users/ada/work/app", homeDir: "/Users/ada" };

describe("streamableReplyText", () => {
  it("sends finished words and holds the word still being written", () => {
    expect(streamableReplyText("The fix is in the par", roots)).toBe("The fix is in the");
  });

  it("holds a line with a path until it ends, then scrubs it like the final message", () => {
    expect(streamableReplyText("Edited /Users/ada/My Proj", roots)).toBe("");
    const line = "Edited /Users/ada/work/app/src/a.ts and done\nNext";
    expect(streamableReplyText(line, roots)).toBe("Edited ./src/a.ts and done");
  });

  it("never sends part of a token: the token waits for the space after it", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(streamableReplyText(`use ${token.slice(0, 20)}`, roots)).toBe("use");
    expect(streamableReplyText(`use ${token} now`, roots)).not.toContain("ghp_");
  });

  it("holds a credential value until its word ends", () => {
    expect(streamableReplyText("password = hunter2hun", roots)).toBe("password =");
    expect(streamableReplyText("password = hunter2hunter ok", roots)).toContain("[REDACTED");
  });

  it("holds a private key block line by line and redacts the lines already complete", () => {
    const header = "-----BEGIN RSA PRIVATE KEY-----";
    expect(streamableReplyText(`key: ${header.slice(0, 18)}`, roots)).toBe("");
    const partial = `${header}\nMIIEowIBAAKCAQEAx${"A".repeat(40)}\nMIIEow`;
    const sent = streamableReplyText(partial, roots);
    expect(sent).toContain("[REDACTED:private-key]");
    expect(sent).not.toContain("MIIE");
  });

  it("is a prefix of what the final scrub sends, for plain prose", () => {
    const full = "First line of the answer.\nSecond line keeps going with words";
    for (let end = 1; end <= full.length; end += 1) {
      const partial = streamableReplyText(full.slice(0, end), roots);
      expect(scrubText(full, roots).startsWith(partial)).toBe(true);
    }
  });
});
