import type { DirectoryEntry } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import { OrgMentions } from "./org-mentions";
import type { OrgFlags } from "./org-service";

const ON: OrgFlags = {
  enabled: true,
  signIn: true,
  workspaces: true,
  remoteSessions: false,
  mentions: true,
};

type Entry = DirectoryEntry & { principal: `user:${string}` };
type MentionsDeps = ConstructorParameters<typeof OrgMentions>[0];
type Client = NonNullable<Awaited<ReturnType<MentionsDeps["getClient"]>>>;

const person = (id: string, displayName: string, email = `${id}@example.com`): Entry => ({
  kind: "user",
  principal: `user:${id}`,
  displayName,
  email,
});

const SELF = person("me", "Omer Machluf", "me@example.com");

/** A provider that matches the query as a substring of one single-word token of the name or email, so a phrase never matches. */
function singleTokenDirectory(all: Entry[]) {
  return vi.fn<Client["searchDirectory"]>(async ({ query, limit }) => {
    const wanted = query.toLowerCase();
    return all
      .filter((entry) =>
        `${entry.displayName} ${entry.email ?? ""}`
          .toLowerCase()
          .split(/\s+/)
          .some((token) => token.includes(wanted)),
      )
      .slice(0, limit);
  });
}

function mentionsOver(all: Entry[]) {
  const searchDirectory = singleTokenDirectory(all);
  const client: Client = {
    supports: () => true,
    whoami: async () => ({
      orgId: "acme",
      principal: SELF.principal,
      email: SELF.email ?? "",
      displayName: SELF.displayName,
      groups: [],
      roles: [],
    }),
    searchDirectory,
    getSession: vi.fn<Client["getSession"]>(),
    grantSession: vi.fn<Client["grantSession"]>(),
  };
  const mentions = new OrgMentions({
    getFlags: () => ON,
    getClient: async () => client,
    sharing: {
      preview: vi.fn<MentionsDeps["sharing"]["preview"]>(),
      share: vi.fn<MentionsDeps["sharing"]["share"]>(),
    },
  });
  return { mentions, searchDirectory };
}

const names = (result: Awaited<ReturnType<OrgMentions["searchDirectory"]>>) =>
  result.success ? result.entries.map((entry) => entry.displayName) : result;

describe("OrgMentions.searchDirectory with several words", () => {
  const directory = [
    person("omer2", "Omer Machluf"),
    person("omar", "Omar Haddad"),
    person("dana", "Dana Machluf"),
    SELF,
  ];

  it("finds a person whose name matches every word, whatever the provider does with a phrase", async () => {
    const { mentions } = mentionsOver(directory);
    expect(names(await mentions.searchDirectory("omer ma"))).toEqual(["Omer Machluf"]);
  });

  it("asks the directory with the longest word at the contract's maximum limit", async () => {
    const { mentions, searchDirectory } = mentionsOver(directory);
    await mentions.searchDirectory("om machluf");
    expect(searchDirectory).toHaveBeenCalledWith({ query: "machluf", limit: 50 });
  });

  it("matches words against the email too, case-insensitively", async () => {
    const { mentions } = mentionsOver([person("dana.k", "Dana Kaplan", "DKaplan@example.com")]);
    expect(names(await mentions.searchDirectory("DANA dkap"))).toEqual(["Dana Kaplan"]);
  });

  it("keeps the directory's order and cuts to eight", async () => {
    const many = Array.from({ length: 20 }, (_, index) => person(`p${index}`, `Pat Lee ${index}`));
    const { mentions } = mentionsOver(many);
    const result = await mentions.searchDirectory("pat le");
    expect(names(result)).toEqual(many.slice(0, 8).map((entry) => entry.displayName));
  });

  it("never returns the signed-in person", async () => {
    const { mentions } = mentionsOver(directory);
    expect(names(await mentions.searchDirectory("omer machluf"))).toEqual(["Omer Machluf"]);
  });
});

describe("OrgMentions.searchDirectory with one word", () => {
  it("is exactly as before: the word, the page of eight, no extra filtering", async () => {
    const { mentions, searchDirectory } = mentionsOver([
      person("omer2", "Omer Machluf"),
      person("x", "Someone Else", "omer-fan@example.com"),
    ]);
    const result = await mentions.searchDirectory("  omer ");
    expect(searchDirectory).toHaveBeenCalledWith({ query: "omer", limit: 8 });
    expect(names(result)).toEqual(["Omer Machluf", "Someone Else"]);
  });
});
