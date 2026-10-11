import { describe, expect, it } from "@effect/vitest";

import { collectDroppedEntries, type DropEntryLike } from "./collectDroppedEntries.ts";

const fileEntry = (name: string, contents = name): DropEntryLike =>
  Object.assign(
    { name, isFile: true, isDirectory: false },
    {
      file: (success: (file: File) => void) => success(new File([contents], name)),
    },
  );

/** Hands out children in batches like Chromium (which caps each readEntries call at 100). */
const directoryEntry = (name: string, children: DropEntryLike[], batchSize = 100): DropEntryLike =>
  Object.assign(
    { name, isFile: false, isDirectory: true },
    {
      createReader: () => {
        let offset = 0;
        return {
          readEntries: (success: (entries: DropEntryLike[]) => void) => {
            const batch = children.slice(offset, offset + batchSize);
            offset += batch.length;
            success(batch);
          },
        };
      },
    },
  );

describe("collectDroppedEntries", () => {
  it("keeps folder structure and lists empty folders", async () => {
    const result = await collectDroppedEntries(
      [
        fileEntry("a.txt"),
        directoryEntry("photos", [fileEntry("1.jpg"), directoryEntry("empty", [])]),
      ],
      [],
    );
    expect(result.files.map((file) => file.relativePath)).toEqual(["a.txt", "photos/1.jpg"]);
    expect(result.directories).toEqual(["photos/empty"]);
  });

  it("reads directories in several batches", async () => {
    const children = Array.from({ length: 250 }, (_, index) => fileEntry(`f${index}.txt`));
    const result = await collectDroppedEntries([directoryEntry("many", children)], []);
    expect(result.files).toHaveLength(250);
  });

  it("falls back to the flat file list without entries", async () => {
    const file = new File(["x"], "plain.txt");
    const result = await collectDroppedEntries([], [file]);
    expect(result).toEqual({ files: [{ relativePath: "plain.txt", file }], directories: [] });
  });
});
