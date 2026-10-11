import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import type { DroppedEntries } from "~/lib/workspaceUpload/collectDroppedEntries";
import { sendUploadBytes } from "~/lib/workspaceUpload/sendUploadBytes";
import {
  startWorkspaceUpload,
  type UploadConflictChoice,
  type WorkspaceUploadProgress,
  type WorkspaceUploadSummary,
} from "~/lib/workspaceUpload/workspaceUploadRun";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { readPreparedConnection, useEnvironmentScope } from "~/state/session";

import type { ConflictRequest } from "./WorkspaceUploadConflictDialog";

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
    description: [parts.join(", "), ...listed].join("\n"),
    timeout: 0,
  });
}

/** Uploads dropped files into the project folder, with progress toast and conflict dialog state. */
export function useWorkspaceUpload(environmentId: EnvironmentId, cwd: string, projectName: string) {
  const canUpload = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const [conflictRequest, setConflictRequest] = useState<ConflictRequest | null>(null);
  const requestIdRef = useRef(0);
  // One dialog at a time: concurrent uploads queue their questions behind this.
  const dialogQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Cancels of runs still in flight, so unmounting never leaves one waiting on the dialog.
  const activeCancelsRef = useRef(new Set<() => void>());

  useEffect(() => {
    const activeCancels = activeCancelsRef.current;
    return () => {
      for (const cancel of activeCancels) cancel();
    };
  }, []);

  const upload = useCallback(
    (targetDirectory: string, entries: DroppedEntries) => {
      if (entries.files.length === 0 && entries.directories.length === 0) return;
      const targetLabel = targetDirectory === "" ? projectName : `${targetDirectory}/`;
      let lastToastUpdate = 0;
      let cancelRun = () => {};
      // Settles this run's open conflict question, if any, as "skip everything".
      let settlePendingConflicts: (() => void) | null = null;
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        cancelRun();
        settlePendingConflicts?.();
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
            const asked = dialogQueueRef.current.then(
              () =>
                new Promise<ReadonlyMap<string, UploadConflictChoice>>((resolve) => {
                  // Cancelled while queued behind another dialog: never show this one.
                  if (cancelled) return resolve(new Map());
                  let settled = false;
                  const settle = (choices: ReadonlyMap<string, UploadConflictChoice>) => {
                    if (settled) return;
                    settled = true;
                    settlePendingConflicts = null;
                    setConflictRequest(null);
                    resolve(choices);
                  };
                  settlePendingConflicts = () => settle(new Map());
                  requestIdRef.current += 1;
                  setConflictRequest({ id: requestIdRef.current, conflicts, resolve: settle });
                }),
            );
            dialogQueueRef.current = asked.catch(() => {});
            return asked;
          },
        },
      });
      cancelRun = run.cancel;
      activeCancelsRef.current.add(cancel);
      void run.done.then((summary) => {
        activeCancelsRef.current.delete(cancel);
        toastManager.close(toastId);
        showSummary(summary, targetLabel);
      });
    },
    [cwd, environmentId, projectName],
  );

  return { canUpload, upload, conflictRequest };
}
