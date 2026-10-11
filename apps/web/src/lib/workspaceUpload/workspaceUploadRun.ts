import {
  type ProjectPrepareUploadInput,
  type ProjectPrepareUploadResult,
  WORKSPACE_UPLOAD_MAX_FILE_BYTES,
  type WorkspaceUploadConflictMode,
} from "@t3tools/contracts";

import type { DroppedEntries } from "./collectDroppedEntries";

export type UploadConflictChoice = "replace" | "keepBoth" | "skip";

export interface UploadConflict {
  readonly relativePath: string;
  readonly existingKind: "file" | "directory";
}

export interface UploadTransfer {
  /** Settles with the HTTP status and response text; rejects on network failure or abort. */
  readonly done: Promise<{ readonly status: number; readonly body: string }>;
  readonly abort: () => void;
}

export interface WorkspaceUploadDeps {
  /** Throws when the call itself fails (offline, no permission). */
  readonly prepare: (input: ProjectPrepareUploadInput) => Promise<ProjectPrepareUploadResult>;
  readonly resolveUrl: (relativeUrl: string) => string | null;
  readonly send: (
    url: string,
    file: Blob,
    onProgress: (loadedBytes: number) => void,
  ) => UploadTransfer;
  /** Asks the user. A conflict missing from the map is skipped. */
  readonly resolveConflicts: (
    conflicts: ReadonlyArray<UploadConflict>,
  ) => Promise<ReadonlyMap<string, UploadConflictChoice>>;
}

export interface WorkspaceUploadProgress {
  readonly totalFiles: number;
  readonly finishedFiles: number;
  readonly totalBytes: number;
  readonly uploadedBytes: number;
}

export interface WorkspaceUploadSummary {
  /** Final relative paths, after any `name (n)` renaming. */
  readonly uploaded: ReadonlyArray<string>;
  readonly skipped: number;
  readonly failed: ReadonlyArray<{ readonly relativePath: string; readonly reason: string }>;
  readonly cancelled: boolean;
}

const PREPARE_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 3;
// Each 409 or repeated conflict costs one more dialog; stop asking after this many.
const MAX_CONFLICT_ROUNDS = 5;

export function joinUploadPath(directory: string, relativePath: string): string {
  return directory === "" ? relativePath : `${directory}/${relativePath}`;
}

interface PrepareRequest {
  readonly relativePath: string;
  readonly mode: WorkspaceUploadConflictMode;
}

interface ReadyUpload extends PrepareRequest {
  readonly relativeUrl: string;
}

export function startWorkspaceUpload(input: {
  readonly cwd: string;
  readonly targetDirectory: string;
  readonly entries: DroppedEntries;
  readonly deps: WorkspaceUploadDeps;
  readonly onProgress: (progress: WorkspaceUploadProgress) => void;
  readonly concurrency?: number;
}): { readonly done: Promise<WorkspaceUploadSummary>; readonly cancel: () => void } {
  const { deps } = input;
  let cancelled = false;
  const activeTransfers = new Set<UploadTransfer>();

  const files = new Map(
    input.entries.files.map((dropped) => [
      joinUploadPath(input.targetDirectory, dropped.relativePath),
      dropped.file,
    ]),
  );
  const totalBytes = [...files.values()].reduce((sum, file) => sum + file.size, 0);
  const loadedBytes = new Map<string, number>();
  const uploaded: string[] = [];
  const failed: Array<{ relativePath: string; reason: string }> = [];
  let skipped = 0;
  let finishedFiles = 0;
  let conflictRounds = 0;

  const report = () =>
    input.onProgress({
      totalFiles: files.size,
      finishedFiles,
      totalBytes,
      uploadedBytes: [...loadedBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
    });
  const finish = (relativePath: string) => {
    finishedFiles += 1;
    loadedBytes.set(relativePath, files.get(relativePath)?.size ?? 0);
    report();
  };
  const fail = (relativePath: string, reason: string) => {
    failed.push({ relativePath, reason });
    finish(relativePath);
  };
  const messageOf = (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback;

  async function prepareBatch(
    requests: ReadonlyArray<PrepareRequest>,
    directories: ReadonlyArray<string>,
  ): Promise<ProjectPrepareUploadResult["files"]> {
    try {
      const result = await deps.prepare({
        cwd: input.cwd,
        directories: [...directories],
        files: requests.map((request) => ({
          relativePath: request.relativePath,
          sizeBytes: files.get(request.relativePath)?.size ?? 0,
          onConflict: request.mode,
        })),
      });
      for (const rejected of result.rejectedDirectories) {
        failed.push({ relativePath: `${rejected.relativePath}/`, reason: rejected.reason });
      }
      return result.files;
    } catch (error) {
      const reason = messageOf(error, "Failed to prepare the upload.");
      return requests.map((request) => ({
        relativePath: request.relativePath,
        status: "rejected" as const,
        reason,
      }));
    }
  }

  /** Prepares until every file is ready, rejected or skipped; asks about conflicts on the way. */
  async function settle(
    initial: ReadonlyArray<PrepareRequest>,
    directories: ReadonlyArray<string>,
  ): Promise<ReadyUpload[]> {
    const ready: ReadyUpload[] = [];
    let pending = [...initial];
    let pendingDirectories = [...directories];
    while ((pending.length > 0 || pendingDirectories.length > 0) && !cancelled) {
      const modes = new Map(pending.map((request) => [request.relativePath, request.mode]));
      const conflicts: UploadConflict[] = [];
      for (let offset = 0; offset < Math.max(pending.length, 1); offset += PREPARE_BATCH_SIZE) {
        const results = await prepareBatch(
          pending.slice(offset, offset + PREPARE_BATCH_SIZE),
          offset === 0 ? pendingDirectories : [],
        );
        for (const result of results) {
          if (result.status === "ready") {
            ready.push({
              relativePath: result.relativePath,
              mode: modes.get(result.relativePath) ?? "fail",
              relativeUrl: result.relativeUrl,
            });
          } else if (result.status === "conflict") {
            conflicts.push({
              relativePath: result.relativePath,
              existingKind: result.existingKind,
            });
          } else {
            fail(result.relativePath, result.reason);
          }
        }
      }
      pendingDirectories = [];
      pending = [];
      if (conflicts.length === 0 || cancelled) break;
      if (++conflictRounds > MAX_CONFLICT_ROUNDS) {
        for (const conflict of conflicts) {
          fail(conflict.relativePath, "Still conflicts with an existing file or folder.");
        }
        break;
      }
      const choices = await deps.resolveConflicts(conflicts);
      for (const conflict of conflicts) {
        const choice = choices.get(conflict.relativePath) ?? "skip";
        if (choice === "skip") {
          skipped += 1;
          finish(conflict.relativePath);
        } else {
          pending.push({ relativePath: conflict.relativePath, mode: choice });
        }
      }
    }
    return ready;
  }

  /** "conflict" means the name was taken by the time the bytes arrived. */
  async function uploadOne(
    item: ReadyUpload,
    mayRefreshUrl: boolean,
  ): Promise<"done" | "conflict"> {
    const file = files.get(item.relativePath);
    const url = deps.resolveUrl(item.relativeUrl);
    if (!file || !url) {
      fail(item.relativePath, "The environment is not connected.");
      return "done";
    }
    const transfer = deps.send(url, file, (bytes) => {
      loadedBytes.set(item.relativePath, bytes);
      report();
    });
    activeTransfers.add(transfer);
    let response: { status: number; body: string };
    try {
      response = await transfer.done;
    } catch (error) {
      if (!cancelled) fail(item.relativePath, messageOf(error, "Upload failed."));
      return "done";
    } finally {
      activeTransfers.delete(transfer);
    }
    if (response.status >= 200 && response.status < 300) {
      uploaded.push(response.body || item.relativePath);
      finish(item.relativePath);
      return "done";
    }
    loadedBytes.set(item.relativePath, 0);
    if (response.status === 409) return "conflict";
    if (response.status === 404 && mayRefreshUrl && !cancelled) {
      // The signed URL expired while the file waited in the queue.
      const [result] = await prepareBatch([item], []);
      if (result?.status === "ready") {
        return uploadOne({ ...item, relativeUrl: result.relativeUrl }, false);
      }
      if (result?.status === "conflict") return "conflict";
      fail(
        item.relativePath,
        result?.status === "rejected" ? result.reason : "Upload link expired.",
      );
      return "done";
    }
    fail(item.relativePath, response.body || `Upload rejected (${response.status}).`);
    return "done";
  }

  async function uploadAll(ready: ReadonlyArray<ReadyUpload>): Promise<PrepareRequest[]> {
    const late: PrepareRequest[] = [];
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < ready.length) {
        const item = ready[next++]!;
        if ((await uploadOne(item, true)) === "conflict") {
          late.push({ relativePath: item.relativePath, mode: "fail" });
        }
      }
    };
    const workers = Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, ready.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return late;
  }

  async function run(): Promise<WorkspaceUploadSummary> {
    report();
    const initial: PrepareRequest[] = [];
    for (const [relativePath, file] of files) {
      if (file.size > WORKSPACE_UPLOAD_MAX_FILE_BYTES) {
        fail(relativePath, "Larger than the 2 GB upload limit.");
      } else {
        initial.push({ relativePath, mode: "fail" });
      }
    }
    const directories = input.entries.directories.map((directory) =>
      joinUploadPath(input.targetDirectory, directory),
    );
    // Every conflict is settled before bytes move, so the dialog comes first.
    let ready = await settle(initial, directories);
    while (ready.length > 0 && !cancelled) {
      const late = await uploadAll(ready);
      ready = late.length > 0 ? await settle(late, []) : [];
    }
    return { uploaded, skipped, failed, cancelled };
  }

  return {
    done: run(),
    cancel: () => {
      cancelled = true;
      for (const transfer of activeTransfers) transfer.abort();
    },
  };
}
