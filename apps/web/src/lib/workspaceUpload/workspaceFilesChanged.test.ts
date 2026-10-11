import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createWorkspaceFilesChangedSignal, workspaceFilesKey } from "./workspaceFilesChanged";

describe("workspaceFilesChanged", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the first change at once and batches the rest per interval", () => {
    const signal = createWorkspaceFilesChangedSignal(1000);
    const listener = vi.fn();
    signal.subscribe("env:/project", listener);

    signal.notify("env:/project");
    expect(listener).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 20; index++) signal.notify("env:/project");
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(2);

    // Nothing new: the interval ends quietly.
    vi.advanceTimersByTime(5000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("flushes at the end of a run without a trailing duplicate", () => {
    const signal = createWorkspaceFilesChangedSignal(1000);
    const listener = vi.fn();
    signal.subscribe("env:/project", listener);

    signal.notify("env:/project");
    signal.notify("env:/project");
    signal.flush("env:/project");
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(listener).toHaveBeenCalledTimes(2);

    // A run with no finished files still refreshes once at its end (folders it created).
    signal.flush("env:/project");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps projects and environments apart, and stops after unsubscribe", () => {
    const signal = createWorkspaceFilesChangedSignal(1000);
    const project = vi.fn();
    const sameCwdOtherEnvironment = vi.fn();
    const unsubscribe = signal.subscribe(workspaceFilesKey("env-a", "/project"), project);
    signal.subscribe(workspaceFilesKey("env-b", "/project"), sameCwdOtherEnvironment);

    signal.notify(workspaceFilesKey("env-a", "/project"));
    signal.notify(workspaceFilesKey("env-a", "/other"));
    expect(project).toHaveBeenCalledTimes(1);
    expect(sameCwdOtherEnvironment).not.toHaveBeenCalled();

    // Throttling is per key too: another project is not held back.
    signal.notify(workspaceFilesKey("env-b", "/project"));
    expect(sameCwdOtherEnvironment).toHaveBeenCalledTimes(1);

    unsubscribe();
    signal.flush(workspaceFilesKey("env-a", "/project"));
    expect(project).toHaveBeenCalledTimes(1);
  });
});
