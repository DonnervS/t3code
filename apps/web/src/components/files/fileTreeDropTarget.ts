const itemPathOf = (node: unknown): string | null => {
  if (typeof node !== "object" || node === null) return null;
  const element = node as { getAttribute?: (name: string) => string | null };
  return typeof element.getAttribute === "function" ? element.getAttribute("data-item-path") : null;
};

/**
 * Folder an OS file drop on the tree goes into, relative to the project root
 * (`""` is the root). Rows live in the tree's open shadow root, so the row is
 * read from the composed event path; folder rows carry a trailing slash.
 */
export function resolveDropTargetDirectory(composedPath: ReadonlyArray<unknown>): string {
  for (const node of composedPath) {
    const itemPath = itemPathOf(node);
    if (itemPath === null) continue;
    if (itemPath.endsWith("/")) return itemPath.slice(0, -1);
    const slash = itemPath.lastIndexOf("/");
    return slash === -1 ? "" : itemPath.slice(0, slash);
  }
  return "";
}

/** Drags from Finder/Explorer carry "Files"; row drags inside the tree do not. */
export function isExternalFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  return types ? Array.from(types).includes("Files") : false;
}
