import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import type { DroppedEntries } from "~/lib/workspaceUpload/collectDroppedEntries";
import { workspaceUploadConflictQueue } from "~/lib/workspaceUpload/conflictQueue";
import { sendUploadBytes } from "~/lib/workspaceUpload/sendUploadBytes";
import {
  workspaceFilesChanged,
  workspaceFilesKey,
} from "~/lib/workspaceUpload/workspaceFilesChanged";
import {
  startWorkspaceUpload,
  type WorkspaceUploadProgress,
  type WorkspaceUploadSummary,
} from "~/lib/workspaceUpload/workspaceUploadRun";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { readPreparedConnection, useEnvironmentScope } from "~/state/session";

const PROGRESS_TOAST_INTERVAL_MS = 250;
const MAX_LISTED_FAILURES = 5;

function progressDescription(progress: WorkspaceUploadProgress): string {
  const files = `${Math.min(progress.finishedFiles, progress.totalFiles)} of ${progress.totalFiles} files`;
  // Skipped and failed files leave the byte total, which can reach 0.
  if (progress.totalBytes <= 0) return files;
  const uploaded = Math.min(progress.uploadedBytes, progress.totalBytes);
  return `${files} · ${formatAttachmentSize(uploaded)} / ${formatAttachmentSize(progress.totalBytes)}`;
}

function showSummary(summary: WorkspaceUploadSummary, targetLabel: string) {
  const parts = [`${summary.uploaded.length} uploaded`];
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.cancelled) {
    toastManager.add({ type: "info", title: "Upload cancelled", description: parts.join(", ") });
    return;
  }
  if (summary.failed.length === 0) {
    toastManager.add({
      type: "success",
      title: `Uploaded to ${targetLabel}`,
      description: parts.join(", "),
    });
    return;
  }
  const listed = summary.failed
    .slice(0, MAX_LISTED_FAILURES)
    .map((failure) => `${failure.relativePath}: ${failure.reason}`);
  if (summary.failed.length > MAX_LISTED_FAILURES) {
    listed.push(`and ${summary.failed.length - MAX_LISTED_FAILURES} more`);
  }
  toastManager.add({
    type: "error",
    title: `${summary.failed.length} ${summary.failed.length === 1 ? "file was" : "files were"} not uploaded`,
    description: parts.join(", "),
    timeout: 0,
    data: {
      // One line per failure; a plain description renders as a single paragraph.
      expandableContent: (
        <ul className="space-y-1 text-muted-foreground">
          {listed.map((line) => (
            <li key={line} className="wrap-break-word">
              {line}
            </li>
          ))}
        </ul>
      ),
      expandableLabels: { collapse: "Hide files", expand: "Show files" },
    },
  });
}

/**
 * Starts an upload owned by the app, not by the panel that received the drop:
 * navigating away never stops it. Only the toast's Cancel button does.
 */
function startUpload(
  environmentId: EnvironmentId,
  cwd: string,
  projectName: string,
  targetDirectory: string,
  entries: DroppedEntries,
) {
  if (entries.files.length === 0 && entries.directories.length === 0) return;
  const targetLabel = targetDirectory === "" ? projectName : `${targetDirectory}/`;
  const filesKey = workspaceFilesKey(environmentId, cwd);
  let lastToastUpdate = 0;
  let cancelRun = () => {};
  let cancelled = false;
  const openQuestions = new Set<() => void>();
  const cancel = () => {
    cancelled = true;
    cancelRun();
    for (const cancelQuestion of openQuestions) cancelQuestion();
  };
  const toastId = toastManager.add({
    type: "loading",
    title: `Uploading to ${targetLabel}`,
    description: "Preparing…",
    timeout: 0,
    actionProps: { children: "Cancel", onClick: cancel },
    data: { hideCopyButton: true },
  });
  const run = startWorkspaceUpload({
    cwd,
    targetDirectory,
    entries,
    onProgress: (progress) => {
      const now = Date.now();
      if (now - lastToastUpdate < PROGRESS_TOAST_INTERVAL_MS) return;
      lastToastUpdate = now;
      toastManager.update(toastId, { description: progressDescription(progress) });
    },
    onFileUploaded: () => workspaceFilesChanged.notify(filesKey),
    deps: {
      prepare: async (input) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          projectEnvironment.prepareUpload,
          { environmentId, input },
          { reportFailure: false },
        );
        if (result._tag === "Success") return result.value;
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error("Failed to prepare the upload.");
      },
      resolveUrl: (relativeUrl) => {
        const connection = readPreparedConnection(environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      send: sendUploadBytes,
      resolveConflicts: (conflicts) => {
        if (cancelled) return Promise.resolve(new Map());
        const question = workspaceUploadConflictQueue.ask(conflicts);
        openQuestions.add(question.cancel);
        return question.promise.finally(() => openQuestions.delete(question.cancel));
      },
    },
  });
  cancelRun = run.cancel;
  void run.done.then((summary) => {
    // Also covers folders created at prepare and files stored before a cancel.
    workspaceFilesChanged.flush(filesKey);
    toastManager.close(toastId);
    showSummary(summary, targetLabel);
  });
}

/** Lets the file tree start uploads; the runs themselves outlive the panel. */
export function useWorkspaceUpload(environmentId: EnvironmentId, cwd: string, projectName: string) {
  const canUpload = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const upload = useCallback(
    (targetDirectory: string, entries: DroppedEntries) =>
      startUpload(environmentId, cwd, projectName, targetDirectory, entries),
    [cwd, environmentId, projectName],
  );
  return { canUpload, upload };
}
