import { OrgApiError, type OrgRoutine, type OrgRunRow } from "@marshal/agent-runtime-org";
import { describe, expect, it, vi } from "vitest";

import type { RoutineDefinition } from "../../../common/routines/routine-definition";
import type { OrgFlags } from "./org-service";
import {
  OrgWorkspaceRoutines,
  type OrgRoutinesClient,
  type OrgWorkspaceRoutinesDeps,
} from "./org-workspace-routines";

const ON: OrgFlags = { enabled: true, signIn: true, workspaces: true, remoteSessions: false };
const OFF: OrgFlags = { ...ON, workspaces: false };

const routine: OrgRoutine = {
  id: "alert-sweep",
  workspaceId: "ws:zyg",
  title: "Alert sweep",
  description: "Daily sweep.",
  workflow: "alert-sweep",
  triggers: { kind: "schedule", schedules: ["0 3 * * *"], manual: true, events: [] },
  definition: {
    repository: "zyg-edge/zyg-agents",
    path: ".github/workflows/alert-sweep.yml",
    url: "https://github.com/zyg-edge/zyg-agents/blob/main/.github/workflows/alert-sweep.yml",
  },
  doc: { path: "docs/alert-sweep.md", url: "https://evil.example.com/docs/alert-sweep.md" },
  channels: ["C0123456789", "C0987654321"],
};

const run: OrgRunRow = {
  id: "r-1",
  type: "run",
  workspace: "ws:zyg",
  workflow: "alert-sweep",
  source: "investigation",
  title: "Sweep of 2026-11-07",
  status: "succeeded",
  startedAt: "2026-11-07T03:00:00Z",
  durationMs: 61_000,
  costUsd: 2.5,
  dryRun: false,
  links: [
    { kind: "slack", key: "C0AAAAAAAAA:1792.100", role: "origin" },
    { kind: "slack", key: "C0123456789:1792.123", role: "output" },
    { kind: "slack", key: "C0123456789:1792.456", role: "output" },
    { kind: "pr", key: "zyg-edge/zyg#12", role: "output" },
    { kind: "linear", key: "ZYG-42", role: "output" },
    { kind: "datadog", key: "issue-1", role: "origin" },
    { kind: "wake", key: "w-1", role: "related" },
  ],
  trigger: "repository_dispatch",
  answer: "Root cause: the backfill skipped one channel.",
  toolErrors: 1,
  flags: ["tool-errors"],
  sessions: [],
  githubUrl: "https://github.com/zyg-edge/zyg-agents/actions/runs/1",
  hasTranscript: true,
  hasEnvelope: false,
};

function make(
  flags: OrgFlags,
  client: Partial<OrgRoutinesClient> | null,
  startAgentRun?: (request: {
    workspaceName?: string;
    title: string;
    prompt: string;
  }) => Promise<string>,
  extra: Partial<OrgWorkspaceRoutinesDeps> = {},
) {
  const openExternal = vi.fn<(url: string) => boolean>(() => true);
  const unused = async (): Promise<never> => {
    throw new Error("not expected in this test");
  };
  const full: OrgRoutinesClient | null = client && {
    supports: () => true,
    listWorkspaceRoutines: async () => [routine],
    listRuns: async () => ({ runs: [run] }),
    getRun: unused,
    listRoutineEvents: unused,
    dispatchRoutine: unused,
    setRoutineEnabled: unused,
    listWorkspaces: unused,
    testRoutine: unused,
    promoteRoutine: unused,
    ...client,
  };
  return {
    service: new OrgWorkspaceRoutines({
      getFlags: () => flags,
      getClient: async () => full,
      openExternal,
      ...(startAgentRun ? { startAgentRun } : {}),
      ...extra,
    }),
    openExternal,
  };
}

const counts = {
  events: 1,
  toolCalls: 0,
  toolErrors: 0,
  evidenceCalls: 0,
  publications: 0,
  failedPublications: 0,
};

describe("OrgWorkspaceRoutines", () => {
  it("is inert with org.workspaces off and refuses malformed requests", async () => {
    const listRuns = vi.fn<OrgRoutinesClient["listRuns"]>();
    const { service } = make(OFF, { listRuns });
    expect(await service.list("ws:zyg")).toEqual({ success: false, error: "disabled" });
    const on = make(ON, { listRuns }).service;
    expect(await on.list("zyg")).toEqual({ success: false, error: "invalid-request" });
    expect(await on.runs({ orgWorkspaceId: "ws:zyg", workflow: "../x" })).toEqual({
      success: false,
      error: "invalid-request",
    });
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("lists routines as views and opens only the github links it served", async () => {
    const { service, openExternal } = make(ON, {});
    expect(await service.list("ws:zyg")).toEqual({
      success: true,
      orgWorkspaceId: "ws:zyg",
      routines: [
        {
          id: "alert-sweep",
          title: "Alert sweep",
          description: "Daily sweep.",
          workflow: "alert-sweep",
          schedules: ["0 3 * * *"],
          manual: true,
          events: [],
          definitionPath: ".github/workflows/alert-sweep.yml",
          definitionUrl: routine.definition.url,
          docUrl: "https://evil.example.com/docs/alert-sweep.md",
          channels: ["C0123456789", "C0987654321"],
          channelCount: 2,
          kind: "schedule",
          hasEvents: true,
          canControl: true,
        },
      ],
    });
    expect(service.openLink(routine.definition.url)).toEqual({ success: true });
    expect(service.openLink(routine.doc!.url)).toEqual({ success: false });
    expect(service.openLink("https://github.com/other")).toEqual({ success: false });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("lists a routine's runs from the run index, bounded, with run view ids", async () => {
    const listRuns = vi.fn<OrgRoutinesClient["listRuns"]>(async () => ({
      runs: [run],
      nextCursor: "2",
    }));
    const { service } = make(ON, { listRuns });
    expect(
      await service.runs({ orgWorkspaceId: "ws:zyg", workflow: "alert-sweep", limit: 500 }),
    ).toEqual({
      success: true,
      more: true,
      runs: [
        {
          viewId: "run:r-1",
          title: "Sweep of 2026-11-07",
          status: "succeeded",
          startedAt: "2026-11-07T03:00:00Z",
          durationMs: 61_000,
          costUsd: 2.5,
          dryRun: false,
          toolErrors: 1,
          flags: ["tool-errors"],
          trigger: "repository_dispatch",
          originChannel: "C0AAAAAAAAA",
          postedChannels: ["C0123456789"],
          slackThreads: 3,
          outputs: [
            {
              kind: "pr",
              key: "zyg-edge/zyg#12",
              role: "output",
              url: "https://github.com/zyg-edge/zyg/pull/12",
            },
            { kind: "linear", key: "ZYG-42", role: "output" },
            { kind: "datadog", key: "issue-1", role: "origin" },
          ],
          answer: "Root cause: the backfill skipped one channel.",
          githubUrl: run.githubUrl,
          hasTranscript: true,
        },
      ],
    });
    expect(listRuns).toHaveBeenCalledWith({
      workspace: "ws:zyg",
      workflow: "alert-sweep",
      limit: 50,
    });
    expect(service.openLink(run.githubUrl!)).toEqual({ success: true });
    expect(service.openLink("https://github.com/zyg-edge/zyg/pull/12")).toEqual({ success: true });
  });

  it("passes channel, status and trigger filters to the run index and refuses malformed ones", async () => {
    const listRuns = vi.fn<OrgRoutinesClient["listRuns"]>(async () => ({ runs: [] }));
    const { service } = make(ON, { listRuns });
    expect(
      await service.runs({
        orgWorkspaceId: "ws:zyg",
        workflow: "alert-sweep",
        channel: "C0123456789",
        status: "failed",
        trigger: "schedule",
      }),
    ).toEqual({ success: true, runs: [], more: false });
    expect(listRuns).toHaveBeenCalledWith({
      workspace: "ws:zyg",
      workflow: "alert-sweep",
      limit: 10,
      channel: "C0123456789",
      status: "failed",
      trigger: "schedule",
    });
    const refused = await Promise.all(
      [{ channel: "#alerts" }, { trigger: "Schedule; drop" }].map((bad) =>
        service.runs({ orgWorkspaceId: "ws:zyg", workflow: "alert-sweep", ...bad }),
      ),
    );
    expect(refused).toEqual([
      { success: false, error: "invalid-request" },
      { success: false, error: "invalid-request" },
    ]);
    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it("reports a missing feature, a signed-out state and a 404 as codes", async () => {
    expect(await make(ON, { supports: () => false }).service.list("ws:zyg")).toEqual({
      success: false,
      error: "unavailable",
    });
    expect(await make(ON, null).service.list("ws:zyg")).toEqual({
      success: false,
      error: "not-signed-in",
    });
    const notFound = make(ON, {
      listWorkspaceRoutines: async () => {
        throw new OrgApiError(404, "not-found", "no");
      },
    });
    expect(await notFound.service.list("ws:zyg")).toEqual({ success: false, error: "not-found" });
  });

  it("lists a routine's events with filters and serves only github links", async () => {
    const listRoutineEvents = vi.fn<OrgRoutinesClient["listRoutineEvents"]>(async () => ({
      events: [
        {
          id: "r-1",
          at: "2026-11-07T03:00:00Z",
          title: "TypeError",
          source: { kind: "datadog", key: "issue-1" },
          channel: "C0123456789",
          severity: "error",
          role: "investigator",
          status: "unhandled",
          runStatus: "failed",
          dryRun: false,
          githubUrl: "https://github.com/zyg-edge/zyg-agents/actions/runs/1",
        },
      ],
      nextCursor: "MQ",
    }));
    const { service } = make(ON, { listRoutineEvents });
    const result = await service.events({
      orgWorkspaceId: "ws:zyg",
      routineId: "investigate",
      severity: "error",
      since: "2026-11-01T00:00:00Z",
      limit: 500,
    });
    expect(result).toEqual({
      success: true,
      events: [
        {
          id: "r-1",
          viewId: "run:r-1",
          at: "2026-11-07T03:00:00Z",
          title: "TypeError",
          sourceKind: "datadog",
          sourceKey: "issue-1",
          channel: "C0123456789",
          severity: "error",
          role: "investigator",
          status: "unhandled",
          runStatus: "failed",
          dryRun: false,
          githubUrl: "https://github.com/zyg-edge/zyg-agents/actions/runs/1",
        },
      ],
      nextCursor: "MQ",
    });
    expect(listRoutineEvents).toHaveBeenCalledWith("ws:zyg", "investigate", {
      severity: "error",
      since: "2026-11-01T00:00:00Z",
      limit: 100,
    });
    expect(service.openLink("https://github.com/zyg-edge/zyg-agents/actions/runs/1")).toEqual({
      success: true,
    });
    for (const bad of [
      { orgWorkspaceId: "zyg", routineId: "investigate" },
      { orgWorkspaceId: "ws:zyg", routineId: "../x" },
      { orgWorkspaceId: "ws:zyg", routineId: "investigate", since: "yesterday" },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each malformed request is checked in turn
      expect(await service.events(bad)).toEqual({
        success: false,
        error: "invalid-request",
      });
    }
  });

  it("runs a routine now, replays an event and turns a routine off through the organization", async () => {
    const dispatchRoutine = vi.fn<OrgRoutinesClient["dispatchRoutine"]>(async () => ({
      started: true as const,
      replayOf: "r-1",
    }));
    const setRoutineEnabled = vi.fn<OrgRoutinesClient["setRoutineEnabled"]>(async () => ({
      enabled: false,
    }));
    const { service } = make(ON, { dispatchRoutine, setRoutineEnabled });
    expect(
      await service.dispatch({
        orgWorkspaceId: "ws:zyg",
        routineId: "investigate",
        eventId: "r-1",
      }),
    ).toEqual({
      success: true,
      replayOf: "r-1",
    });
    expect(dispatchRoutine).toHaveBeenCalledWith("ws:zyg", "investigate", { eventId: "r-1" });
    expect(
      await service.setEnabled({
        orgWorkspaceId: "ws:zyg",
        routineId: "investigate",
        enabled: false,
      }),
    ).toEqual({
      success: true,
      enabled: false,
    });
    expect(
      await service.setEnabled({
        orgWorkspaceId: "zyg",
        routineId: "investigate",
        enabled: true,
      }),
    ).toEqual({ success: false, error: "invalid-request" });
    const old = make(ON, { supports: (feature) => feature !== "routineActions" });
    expect(
      await old.service.dispatch({ orgWorkspaceId: "ws:zyg", routineId: "alert-sweep" }),
    ).toEqual({
      success: false,
      error: "unavailable",
    });
  });

  it("tests an event locally in a new chat with the event wrapped as untrusted content", async () => {
    const startAgentRun = vi.fn<
      (request: { workspaceName?: string; title: string; prompt: string }) => Promise<string>
    >(async () => "session-9");
    const { service } = make(
      ON,
      { getRun: async () => ({ run, counts, sessions: [] }) },
      startAgentRun,
    );
    expect(
      await service.testLocally({
        orgWorkspaceId: "ws:zyg",
        routineId: "alert-sweep",
        eventId: "r-1",
        workspaceName: "zyg",
      }),
    ).toEqual({ success: true, sessionId: "session-9" });
    const request = startAgentRun.mock.calls[0]?.[0];
    expect(request?.workspaceName).toBe("zyg");
    expect(request?.title).toBe("Test: Alert sweep");
    expect(request?.prompt).toContain('<external_content source="org_session">');
    expect(request?.prompt).toContain("Sweep of 2026-11-07");
    expect(request?.prompt).toContain("do not post to Slack");
    const other = make(
      ON,
      {
        getRun: async () => ({
          run: { ...run, workflow: "other" },
          counts,
          sessions: [],
        }),
      },
      startAgentRun,
    );
    expect(
      await other.service.testLocally({
        orgWorkspaceId: "ws:zyg",
        routineId: "alert-sweep",
        eventId: "r-1",
      }),
    ).toEqual({ success: false, error: "not-found" });
    expect(startAgentRun).toHaveBeenCalledTimes(1);
  });

  const definition: RoutineDefinition = {
    id: "standup",
    title: "Standup",
    triggers: { schedules: ["0 6 * * 0-4"], events: [], manual: true },
    body: { agent: { prompt: "Summarize yesterday's #data-issues in 3 lines." } },
    outputs: { channels: [], people: [] },
    placement: "local",
    enabled: true,
    workspaces: [],
  };
  const readLocalRoutine = vi.fn<NonNullable<OrgWorkspaceRoutinesDeps["readLocalRoutine"]>>(
    ({ key }) =>
      key === "repo:standup"
        ? { ok: true, routine: definition }
        : key === "repo:script"
          ? { ok: true, routine: { ...definition, id: "script", body: { workflow: "script" } } }
          : { ok: false, error: "not-found" },
  );

  it("tests a local agent routine once in the cloud and finds its run by test id", async () => {
    const testRoutine = vi.fn<OrgRoutinesClient["testRoutine"]>(async () => ({
      testId: "rtAbCdEf1234",
      title: "Test: Standup · rtAbCdEf1234",
      runs: { workspace: "ws:zyg", workflow: "agent-routine", q: "rtAbCdEf1234" },
    }));
    const listRuns = vi.fn<OrgRoutinesClient["listRuns"]>();
    listRuns
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValue({ runs: [{ ...run, id: "r-77", workflow: "agent-routine" }] });
    const { service } = make(ON, { testRoutine, listRuns }, undefined, { readLocalRoutine });
    const request = { orgWorkspaceId: "ws:zyg", workspaceName: "zyg", localKey: "repo:standup" };
    const started = await service.testInCloud(request);
    expect(started).toEqual({
      success: true,
      testId: "rtAbCdEf1234",
      title: "Test: Standup · rtAbCdEf1234",
      runs: { orgWorkspaceId: "ws:zyg", workflow: "agent-routine", testId: "rtAbCdEf1234" },
    });
    const { id: _id, ...file } = definition;
    expect(testRoutine).toHaveBeenCalledWith("ws:zyg", "standup", {
      ...file,
      placement: "cloud",
    });
    const query = { orgWorkspaceId: "ws:zyg", workflow: "agent-routine", testId: "rtAbCdEf1234" };
    expect(await service.findTestRun(query)).toEqual({ success: true });
    expect(await service.findTestRun(query)).toEqual({
      success: true,
      run: {
        runId: "r-77",
        viewId: "run:r-77",
        status: "succeeded",
        hasTranscript: true,
        githubUrl: run.githubUrl,
      },
    });
    expect(listRuns).toHaveBeenLastCalledWith({
      workspace: "ws:zyg",
      workflow: "agent-routine",
      q: "rtAbCdEf1234",
      limit: 1,
    });
    expect(await service.findTestRun({ ...query, testId: "../x" })).toEqual({
      success: false,
      error: "invalid-request",
    });
    expect(await service.testInCloud({ ...request, localKey: "repo:script" })).toEqual({
      success: false,
      error: "not-promotable",
    });
    expect(await service.testInCloud({ ...request, localKey: "repo:missing" })).toEqual({
      success: false,
      error: "not-found",
    });
    expect(
      await make(OFF, {}, undefined, { readLocalRoutine }).service.testInCloud(request),
    ).toEqual({ success: false, error: "disabled" });
    expect(testRoutine).toHaveBeenCalledTimes(1);
  });

  it("promotes a local routine through a pull request and passes refusals through", async () => {
    const promoteRoutine = vi.fn<OrgRoutinesClient["promoteRoutine"]>(async () => ({
      pullRequest: {
        number: 1800,
        url: "https://github.com/zyg-edge/zyg-agents/pull/1800",
        branch: "routine/standup",
      },
    }));
    const { service, openExternal } = make(
      ON,
      {
        promoteRoutine,
        listWorkspaces: async () => [
          { id: "ws:zyg", displayName: "Zyg", repositories: [] },
          { id: "ws:zygstinct", displayName: "Zygstinct", repositories: [] },
        ],
      },
      undefined,
      { readLocalRoutine },
    );
    expect(await service.promoteTargets()).toEqual({
      success: true,
      workspaces: [
        { id: "ws:zyg", name: "Zyg" },
        { id: "ws:zygstinct", name: "Zygstinct" },
      ],
    });
    const request = { orgWorkspaceId: "ws:zyg", workspaceName: "zyg", localKey: "repo:standup" };
    expect(await service.promote(request)).toEqual({
      success: true,
      prUrl: "https://github.com/zyg-edge/zyg-agents/pull/1800",
      number: 1800,
    });
    expect(promoteRoutine.mock.calls[0]?.[1]).toBe("standup");
    expect(service.openLink("https://github.com/zyg-edge/zyg-agents/pull/1800")).toEqual({
      success: true,
    });
    expect(openExternal).toHaveBeenCalledOnce();

    const exists = new OrgApiError(409, "routine-exists", "conflict", undefined, {
      problem: "routines/standup.yaml already exists",
      pullRequest: {
        number: 1799,
        url: "https://github.com/zyg-edge/zyg-agents/pull/1799",
        branch: "routine/standup",
      },
    });
    promoteRoutine.mockRejectedValueOnce(exists);
    expect(await service.promote(request)).toEqual({
      success: false,
      error: "routine-exists",
      message: "routines/standup.yaml already exists",
      prUrl: "https://github.com/zyg-edge/zyg-agents/pull/1799",
    });
    promoteRoutine.mockRejectedValueOnce(new OrgApiError(502, "github-unavailable", "bad gateway"));
    expect(await service.promote(request)).toEqual({
      success: false,
      error: "github-unavailable",
    });
    promoteRoutine.mockResolvedValueOnce({
      pullRequest: { number: 1, url: "https://evil.example.com/pull/1", branch: "x" },
    });
    expect(await service.promote(request)).toEqual({ success: false, error: "invalid-reply" });
  });
});
