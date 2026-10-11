import { describe, expect, it } from "@effect/vitest";
import type { ProjectPrepareUploadInput, ProjectPrepareUploadResult } from "@t3tools/contracts";

import type { DroppedEntries } from "./collectDroppedEntries.ts";
import {
  startWorkspaceUpload,
  type UploadConflict,
  type UploadConflictChoice,
  type UploadTransfer,
  type WorkspaceUploadDeps,
} from "./workspaceUploadRun.ts";

const entries = (...paths: string[]): DroppedEntries => ({
  files: paths.map((relativePath) => ({ relativePath, file: new File(["abc"], relativePath) })),
  directories: [],
});

/** In-memory server: `existing` names conflict in `fail` mode; sends succeed unless scripted. */
function fakeServer(options: {
  existing?: string[];
  statuses?: Record<string, number[]>;
  choices?: Record<string, UploadConflictChoice>;
}) {
  const existing = new Set(options.existing ?? []);
  const prepareCalls: ProjectPrepareUploadInput[] = [];
  const conflictRounds: UploadConflict[][] = [];
  const sent: string[] = [];
  const deps: WorkspaceUploadDeps = {
    prepare: async (input) => {
      prepareCalls.push(input);
      return {
        files: input.files.map((file) =>
          existing.has(file.relativePath) && file.onConflict === "fail"
            ? { relativePath: file.relativePath, status: "conflict", existingKind: "file" }
            : {
                relativePath: file.relativePath,
                status: "ready",
                relativeUrl: `/u/${file.onConflict}/${file.relativePath}`,
                expiresAt: 0,
              },
        ),
        rejectedDirectories: [],
      } satisfies ProjectPrepareUploadResult;
    },
    resolveUrl: (relativeUrl) => `http://host${relativeUrl}`,
    send: (url, _file, onProgress): UploadTransfer => {
      const relativePath = url.split("/").slice(5).join("/");
      sent.push(url);
      const scripted = options.statuses?.[relativePath];
      const status = scripted && scripted.length > 0 ? scripted.shift()! : 200;
      onProgress(3);
      return {
        done: Promise.resolve({ status, body: status === 200 ? relativePath : "" }),
        abort: () => {},
      };
    },
    resolveConflicts: async (conflicts) => {
      conflictRounds.push([...conflicts]);
      return new Map(
        conflicts.flatMap((conflict) => {
          const choice = options.choices?.[conflict.relativePath];
          return choice ? [[conflict.relativePath, choice] as const] : [];
        }),
      );
    },
  };
  return { deps, prepareCalls, conflictRounds, sent, existing };
}

describe("startWorkspaceUpload", () => {
  it("uploads every file into the target folder and reports progress to the end", async () => {
    const server = fakeServer({});
    const progress: number[] = [];
    const run = startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "docs",
      entries: entries("a.txt", "sub/b.txt"),
      deps: server.deps,
      onProgress: (p) => progress.push(p.finishedFiles),
    });
    const summary = await run.done;
    expect(summary).toEqual({
      uploaded: ["docs/a.txt", "docs/sub/b.txt"],
      skipped: 0,
      failed: [],
      cancelled: false,
    });
    expect(server.prepareCalls[0]?.files.map((f) => f.relativePath)).toEqual([
      "docs/a.txt",
      "docs/sub/b.txt",
    ]);
    expect(progress.at(-1)).toBe(2);
  });

  it("asks once for all conflicts before uploading and applies the choices", async () => {
    const server = fakeServer({
      existing: ["a.txt", "b.txt", "c.txt"],
      choices: { "a.txt": "replace", "b.txt": "keepBoth", "c.txt": "skip" },
    });
    const run = startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt", "b.txt", "c.txt", "d.txt"),
      deps: server.deps,
      onProgress: () => {},
    });
    const summary = await run.done;
    expect(server.conflictRounds).toHaveLength(1);
    expect(server.conflictRounds[0]?.map((c) => c.relativePath)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(server.sent.some((url) => url.includes("/replace/a.txt"))).toBe(true);
    expect(server.sent.some((url) => url.includes("/keepBoth/b.txt"))).toBe(true);
    expect(summary.skipped).toBe(1);
    expect(summary.uploaded).toHaveLength(3);
  });

  it("treats conflicts without a choice as skipped", async () => {
    const server = fakeServer({ existing: ["a.txt"] });
    const summary = await startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt"),
      deps: server.deps,
      onProgress: () => {},
    }).done;
    expect(summary).toMatchObject({ uploaded: [], skipped: 1, failed: [] });
  });

  it("refreshes an expired upload URL once", async () => {
    const server = fakeServer({ statuses: { "a.txt": [404] } });
    const summary = await startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt"),
      deps: server.deps,
      onProgress: () => {},
    }).done;
    expect(server.sent).toHaveLength(2);
    expect(summary.uploaded).toEqual(["a.txt"]);
  });

  it("treats a 409 as a new conflict and asks again", async () => {
    const server = fakeServer({ statuses: { "a.txt": [409] }, choices: { "a.txt": "keepBoth" } });
    // After the 409 the name is taken on the server.
    const originalPrepare = server.deps.prepare;
    let calls = 0;
    const deps: WorkspaceUploadDeps = {
      ...server.deps,
      prepare: async (input) => {
        if (calls++ > 0) server.existing.add("a.txt");
        return originalPrepare(input);
      },
    };
    const summary = await startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt"),
      deps,
      onProgress: () => {},
    }).done;
    expect(server.conflictRounds).toHaveLength(1);
    expect(server.sent.at(-1)).toContain("/keepBoth/a.txt");
    expect(summary.uploaded).toEqual(["a.txt"]);
  });

  it("rejects files over 2 GB without sending them", async () => {
    const server = fakeServer({});
    const huge = { size: 2 * 1024 ** 3 + 1 } as File;
    const summary = await startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: { files: [{ relativePath: "huge.bin", file: huge }], directories: [] },
      deps: server.deps,
      onProgress: () => {},
    }).done;
    expect(server.sent).toEqual([]);
    expect(summary.failed).toEqual([
      { relativePath: "huge.bin", reason: "Larger than the 2 GB upload limit." },
    ]);
  });

  it("marks a batch failed when prepare fails", async () => {
    const server = fakeServer({});
    const deps: WorkspaceUploadDeps = {
      ...server.deps,
      prepare: async () => {
        throw new Error("offline");
      },
    };
    const summary = await startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt"),
      deps,
      onProgress: () => {},
    }).done;
    expect(summary.failed).toEqual([{ relativePath: "a.txt", reason: "offline" }]);
  });

  it("aborts running transfers on cancel", async () => {
    const server = fakeServer({});
    let aborted = 0;
    const deps: WorkspaceUploadDeps = {
      ...server.deps,
      send: () => {
        let reject: (error: Error) => void = () => {};
        const done = new Promise<{ status: number; body: string }>((_, r) => {
          reject = r;
        });
        return {
          done,
          abort: () => {
            aborted++;
            reject(new Error("Upload cancelled"));
          },
        };
      },
    };
    const run = startWorkspaceUpload({
      cwd: "/w",
      targetDirectory: "",
      entries: entries("a.txt", "b.txt"),
      deps,
      onProgress: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.cancel();
    const summary = await run.done;
    expect(aborted).toBe(2);
    expect(summary).toMatchObject({ cancelled: true, uploaded: [], failed: [] });
  });
});
