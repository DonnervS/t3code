import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ProjectPrepareUploadInput,
  ProjectPrepareUploadResult,
  WORKSPACE_UPLOAD_MAX_FILES,
} from "./workspaceUpload.ts";

const decodeInput = Schema.decodeUnknownSync(ProjectPrepareUploadInput);
const decodeResult = Schema.decodeUnknownSync(ProjectPrepareUploadResult);

describe("ProjectPrepareUploadInput", () => {
  it("accepts files, zero-byte files and empty directories", () => {
    expect(
      decodeInput({
        cwd: "/workspace",
        directories: ["empty/nested"],
        files: [
          { relativePath: "docs/report.pdf", sizeBytes: 0, onConflict: "fail" },
          { relativePath: "docs/a.txt", sizeBytes: 12, onConflict: "keepBoth" },
        ],
      }),
    ).toMatchObject({
      directories: ["empty/nested"],
      files: [{ relativePath: "docs/report.pdf" }, { onConflict: "keepBoth" }],
    });
  });

  it("rejects unknown conflict modes and negative sizes", () => {
    expect(() =>
      decodeInput({
        cwd: "/workspace",
        directories: [],
        files: [{ relativePath: "a.txt", sizeBytes: 1, onConflict: "merge" }],
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        cwd: "/workspace",
        directories: [],
        files: [{ relativePath: "a.txt", sizeBytes: -1, onConflict: "fail" }],
      }),
    ).toThrow();
  });

  it("keeps leading and trailing spaces in upload paths", () => {
    // " notes.txt" is a valid name; trimming it would upload under another name.
    const decoded = decodeInput({
      cwd: "/workspace",
      directories: [" folder "],
      files: [{ relativePath: " notes.txt ", sizeBytes: 1, onConflict: "fail" }],
    });
    expect(decoded.directories).toEqual([" folder "]);
    expect(decoded.files[0]?.relativePath).toBe(" notes.txt ");
    expect(() =>
      decodeInput({
        cwd: "/workspace",
        directories: [],
        files: [{ relativePath: "", sizeBytes: 1, onConflict: "fail" }],
      }),
    ).toThrow();
  });

  it("caps the number of files per call", () => {
    const files = Array.from({ length: WORKSPACE_UPLOAD_MAX_FILES + 1 }, (_, index) => ({
      relativePath: `f${index}.txt`,
      sizeBytes: 1,
      onConflict: "fail",
    }));
    expect(() => decodeInput({ cwd: "/workspace", directories: [], files })).toThrow();
  });
});

describe("ProjectPrepareUploadResult", () => {
  it("decodes every per-file status", () => {
    const result = decodeResult({
      files: [
        {
          relativePath: "a.txt",
          status: "ready",
          relativeUrl: "/api/projects/upload/x.y",
          expiresAt: 1,
        },
        { relativePath: "b.txt", status: "conflict", existingKind: "directory" },
        { relativePath: "../c.txt", status: "rejected", reason: "Outside the project folder." },
      ],
      rejectedDirectories: [
        { relativePath: "blocked/sub", reason: "A file with that name is in the way." },
      ],
    });
    expect(result.files.map((file) => file.status)).toEqual(["ready", "conflict", "rejected"]);
  });

  it("echoes upload paths with their spaces, so the client can match them", () => {
    const result = decodeResult({
      files: [
        { relativePath: " notes.txt", status: "conflict", existingKind: "file" },
        { relativePath: "a. ", status: "rejected", reason: "Not a valid file name." },
      ],
      rejectedDirectories: [{ relativePath: " folder", reason: "Blocked." }],
    });
    expect(result.files.map((file) => file.relativePath)).toEqual([" notes.txt", "a. "]);
    expect(result.rejectedDirectories[0]?.relativePath).toBe(" folder");
  });
});
