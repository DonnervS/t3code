import type { UploadConflict, UploadConflictChoice } from "./workspaceUploadRun";

export interface ConflictRequest {
  readonly id: number;
  readonly conflicts: ReadonlyArray<UploadConflict>;
  readonly resolve: (choices: ReadonlyMap<string, UploadConflictChoice>) => void;
}

type Choices = ReadonlyMap<string, UploadConflictChoice>;

interface QueuedAsk {
  readonly request: ConflictRequest;
  readonly settle: (choices: Choices) => void;
}

/**
 * Shows name-conflict questions one dialog at a time, for every upload in the
 * app. Lives outside React so uploads outlive the panel that started them.
 */
export function createConflictQueue() {
  let nextId = 0;
  let current: QueuedAsk | null = null;
  const waiting: QueuedAsk[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const advance = () => {
    current = waiting.shift() ?? null;
    notify();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): ConflictRequest | null {
      return current?.request ?? null;
    },
    /** `cancel` settles the question as "skip everything", whether it is open or still queued. */
    ask(conflicts: ReadonlyArray<UploadConflict>): {
      promise: Promise<Choices>;
      cancel: () => void;
    } {
      let settled = false;
      let resolvePromise: (choices: Choices) => void = () => {};
      const promise = new Promise<Choices>((resolve) => {
        resolvePromise = resolve;
      });
      const entry: QueuedAsk = {
        request: {
          id: ++nextId,
          conflicts,
          resolve: (choices) => settle(choices),
        },
        settle: (choices) => settle(choices),
      };
      function settle(choices: Choices) {
        if (settled) return;
        settled = true;
        resolvePromise(choices);
        if (current === entry) advance();
        else {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
        }
      }
      if (current === null) {
        current = entry;
        notify();
      } else {
        waiting.push(entry);
      }
      return { promise, cancel: () => settle(new Map()) };
    },
  };
}

export const workspaceUploadConflictQueue = createConflictQueue();
