// Enough for a tree to follow a large drop without re-listing folders per file.
const REFRESH_INTERVAL_MS = 1000;

/** Identifies one project folder in one environment. */
export function workspaceFilesKey(environmentId: string, cwd: string): string {
  return `${environmentId}:${cwd}`;
}

/**
 * Tells file trees that uploads changed a project folder. Upload runs outlive the
 * panel that started them, so trees subscribe by folder instead of passing callbacks.
 */
export function createWorkspaceFilesChangedSignal(intervalMs: number) {
  const listeners = new Map<string, Set<() => void>>();
  const throttles = new Map<
    string,
    { readonly timer: ReturnType<typeof setTimeout>; pending: boolean }
  >();

  const emit = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  const holdBack = (key: string) => {
    const throttle = {
      pending: false,
      timer: setTimeout(() => {
        throttles.delete(key);
        if (!throttle.pending) return;
        emit(key);
        holdBack(key);
      }, intervalMs),
    };
    throttles.set(key, throttle);
  };

  return {
    subscribe(key: string, listener: () => void): () => void {
      const keyListeners = listeners.get(key) ?? new Set();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    },
    /** A file landed: the first change shows at once, later ones once per interval. */
    notify(key: string) {
      const throttle = throttles.get(key);
      if (throttle) {
        throttle.pending = true;
        return;
      }
      emit(key);
      holdBack(key);
    },
    /** A run ended: shows its final state now, replacing any change still held back. */
    flush(key: string) {
      const throttle = throttles.get(key);
      if (throttle) {
        clearTimeout(throttle.timer);
        throttles.delete(key);
      }
      emit(key);
    },
  };
}

export const workspaceFilesChanged = createWorkspaceFilesChangedSignal(REFRESH_INTERVAL_MS);
