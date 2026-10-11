/** The part of the File and Directory Entries API the drop reader needs. */
export interface DropEntryLike {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

interface FileEntryLike extends DropEntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}

interface DirectoryEntryLike extends DropEntryLike {
  createReader(): {
    readEntries(
      success: (entries: DropEntryLike[]) => void,
      failure?: (error: unknown) => void,
    ): void;
  };
}

export interface DroppedFile {
  /** Relative to the drop target, POSIX separators. */
  readonly relativePath: string;
  readonly file: File;
}

export interface DroppedEntries {
  readonly files: ReadonlyArray<DroppedFile>;
  /** Folders without any files below them; others are created with their files. */
  readonly directories: ReadonlyArray<string>;
}

const readFile = (entry: FileEntryLike) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** readEntries returns children in batches (100 in Chromium) until it returns none. */
async function readChildren(entry: DirectoryEntryLike): Promise<DropEntryLike[]> {
  const reader = entry.createReader();
  const children: DropEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<DropEntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return children;
    children.push(...batch);
  }
}

/**
 * Turns a drop into files with paths relative to the drop target. `entries`
 * must be taken from `DataTransferItem.webkitGetAsEntry()` while the drop event
 * runs; without them the flat `fallbackFiles` are used (no folders).
 */
export async function collectDroppedEntries(
  entries: ReadonlyArray<DropEntryLike>,
  fallbackFiles: ReadonlyArray<File>,
): Promise<DroppedEntries> {
  if (entries.length === 0) {
    return {
      files: fallbackFiles.map((file) => ({ relativePath: file.name, file })),
      directories: [],
    };
  }
  const files: DroppedFile[] = [];
  const directories: string[] = [];
  const visit = async (entry: DropEntryLike, parent: string): Promise<void> => {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      files.push({ relativePath, file: await readFile(entry as FileEntryLike) });
      return;
    }
    if (!entry.isDirectory) return;
    const children = await readChildren(entry as DirectoryEntryLike);
    if (children.length === 0) directories.push(relativePath);
    for (const child of children) await visit(child, relativePath);
  };
  for (const entry of entries) await visit(entry, "");
  return { files, directories };
}
