import { describe, expect, it } from "@effect/vitest";

import { createConflictQueue } from "./conflictQueue";

const conflicts = [{ relativePath: "a.txt", existingKind: "file" as const }];

describe("createConflictQueue", () => {
  it("shows one question at a time, in order", async () => {
    const queue = createConflictQueue();
    const first = queue.ask(conflicts);
    const second = queue.ask(conflicts);
    const firstRequest = queue.getSnapshot()!;
    firstRequest.resolve(new Map([["a.txt", "replace"]]));
    expect((await first.promise).get("a.txt")).toBe("replace");
    expect(queue.getSnapshot()).not.toBe(firstRequest);
    expect(queue.getSnapshot()).not.toBeNull();
    queue.getSnapshot()!.resolve(new Map());
    await second.promise;
    expect(queue.getSnapshot()).toBeNull();
  });

  it("settles a queued question immediately when cancelled", async () => {
    const queue = createConflictQueue();
    queue.ask(conflicts);
    const second = queue.ask(conflicts);
    second.cancel();
    expect((await second.promise).size).toBe(0);
  });

  it("cancelling the open question closes it and advances", async () => {
    const queue = createConflictQueue();
    const first = queue.ask(conflicts);
    queue.ask(conflicts);
    const secondRequest = queue.getSnapshot();
    first.cancel();
    expect((await first.promise).size).toBe(0);
    expect(queue.getSnapshot()).not.toBe(secondRequest);
    expect(queue.getSnapshot()).not.toBeNull();
  });

  it("notifies subscribers and ignores a second resolve", () => {
    const queue = createConflictQueue();
    let calls = 0;
    queue.subscribe(() => calls++);
    const ask = queue.ask(conflicts);
    const request = queue.getSnapshot()!;
    request.resolve(new Map());
    request.resolve(new Map());
    ask.cancel();
    expect(queue.getSnapshot()).toBeNull();
    expect(calls).toBe(2);
  });
});
