import { describe, expect, it } from "@effect/vitest";

import { isExternalFileDrag, resolveDropTargetDirectory } from "./fileTreeDropTarget.ts";

const rowNode = (path: string) => ({
  getAttribute: (name: string) => (name === "data-item-path" ? path : null),
});

describe("resolveDropTargetDirectory", () => {
  it("uses a folder row as the target", () => {
    expect(resolveDropTargetDirectory([{}, rowNode("docs/api/"), {}])).toBe("docs/api");
  });

  it("uses the parent folder of a file row", () => {
    expect(resolveDropTargetDirectory([rowNode("docs/index.md")])).toBe("docs");
  });

  it("uses the project root for a top-level file row or blank space", () => {
    expect(resolveDropTargetDirectory([rowNode("README.md")])).toBe("");
    expect(resolveDropTargetDirectory([{}, { getAttribute: () => null }])).toBe("");
  });
});

describe("isExternalFileDrag", () => {
  it("accepts drags that carry OS files only", () => {
    expect(isExternalFileDrag(["Files"])).toBe(true);
    expect(isExternalFileDrag(["text/plain", "application/x-t3-mention"])).toBe(false);
    expect(isExternalFileDrag(null)).toBe(false);
  });
});
