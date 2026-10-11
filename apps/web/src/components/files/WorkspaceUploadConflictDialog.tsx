import { useRef, useState, useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  workspaceUploadConflictQueue,
  type ConflictRequest,
} from "~/lib/workspaceUpload/conflictQueue";
import type { UploadConflictChoice } from "~/lib/workspaceUpload/workspaceUploadRun";

/** Walks through name conflicts one at a time; mount with `key={request.id}`. */
function WorkspaceUploadConflictDialog({ request }: { request: ConflictRequest }) {
  const [index, setIndex] = useState(0);
  const [applyToAll, setApplyToAll] = useState(false);
  const choices = useRef(new Map<string, UploadConflictChoice>());
  const conflict = request.conflicts[index];
  if (!conflict) return null;

  const remaining = request.conflicts.length - index;
  const slash = conflict.relativePath.lastIndexOf("/");
  const name = conflict.relativePath.slice(slash + 1);
  const folder = slash === -1 ? null : conflict.relativePath.slice(0, slash);

  const choose = (choice: UploadConflictChoice) => {
    const targets = applyToAll ? request.conflicts.slice(index) : [conflict];
    for (const target of targets) {
      // A folder can be kept next to the upload but never replaced by it.
      choices.current.set(
        target.relativePath,
        choice === "replace" && target.existingKind === "directory" ? "skip" : choice,
      );
    }
    const nextIndex = index + targets.length;
    if (nextIndex >= request.conflicts.length) request.resolve(choices.current);
    else setIndex(nextIndex);
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Dismissing skips everything not decided yet; the other files still upload.
        if (!open) {
          for (const pending of request.conflicts.slice(index)) {
            choices.current.set(pending.relativePath, "skip");
          }
          request.resolve(choices.current);
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <code className="font-medium">{name}</code> already exists
          </AlertDialogTitle>
          <AlertDialogDescription>
            {conflict.existingKind === "directory" ? "A folder" : "A file"} with this name is
            already in {folder ? <code>{folder}/</code> : "the project root"}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remaining > 1 ? (
          <label className="flex items-center gap-2 px-6 text-sm">
            <Checkbox
              checked={applyToAll}
              onCheckedChange={(checked) => setApplyToAll(checked === true)}
            />
            Apply to all {remaining} conflicts
          </label>
        ) : null}
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => choose("skip")}>
            Skip
          </Button>
          <Button variant="outline" onClick={() => choose("keepBoth")}>
            Keep both
          </Button>
          {conflict.existingKind === "file" ? (
            <Button variant="destructive" onClick={() => choose("replace")}>
              Replace
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Mounted once at app level; answers the questions of every running upload. */
export function WorkspaceUploadConflictDialogHost() {
  const request = useSyncExternalStore(
    workspaceUploadConflictQueue.subscribe,
    workspaceUploadConflictQueue.getSnapshot,
    () => null,
  );
  return request ? <WorkspaceUploadConflictDialog key={request.id} request={request} /> : null;
}
