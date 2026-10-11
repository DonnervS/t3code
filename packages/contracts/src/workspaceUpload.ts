import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** HTTP route that receives the bytes of one signed workspace upload. */
export const WORKSPACE_UPLOAD_ROUTE_PREFIX = "/api/projects/upload";
export const WORKSPACE_UPLOAD_URL_TTL_MS = 10 * 60_000;
export const WORKSPACE_UPLOAD_MAX_FILE_BYTES = 2 * 1024 ** 3;
export const WORKSPACE_UPLOAD_MAX_FILES = 10_000;
/** Temporary file an upload streams into, next to its target, before it is moved into place. */
export const WORKSPACE_UPLOAD_PART_SUFFIX = ".t3upload.part";
const WORKSPACE_UPLOAD_PATH_MAX_LENGTH = 1024;

/**
 * What finishing an upload does when the target name is taken: `fail` reports a
 * conflict, `replace` overwrites a file, `keepBoth` picks `name (n).ext`.
 */
export const WorkspaceUploadConflictMode = Schema.Literals(["fail", "replace", "keepBoth"]);
export type WorkspaceUploadConflictMode = typeof WorkspaceUploadConflictMode.Type;

/**
 * Not trimmed: " notes.txt" is a valid name on every host, and the client matches
 * results to its files by this exact string.
 */
const WorkspaceUploadPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(WORKSPACE_UPLOAD_PATH_MAX_LENGTH),
);

export const ProjectPrepareUploadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Folders to create even when empty, relative to `cwd`. */
  directories: Schema.Array(WorkspaceUploadPath).check(
    Schema.isMaxLength(WORKSPACE_UPLOAD_MAX_FILES),
  ),
  files: Schema.Array(
    Schema.Struct({
      relativePath: WorkspaceUploadPath,
      // The size limit is checked per file on the server, so one oversized file
      // is reported as rejected instead of failing the whole call.
      sizeBytes: NonNegativeInt,
      onConflict: WorkspaceUploadConflictMode,
    }),
  ).check(Schema.isMaxLength(WORKSPACE_UPLOAD_MAX_FILES)),
});
export type ProjectPrepareUploadInput = typeof ProjectPrepareUploadInput.Type;

export const ProjectPrepareUploadFileResult = Schema.Union([
  Schema.Struct({
    relativePath: WorkspaceUploadPath,
    status: Schema.Literal("ready"),
    relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    relativePath: WorkspaceUploadPath,
    status: Schema.Literal("conflict"),
    existingKind: Schema.Literals(["file", "directory"]),
  }),
  Schema.Struct({
    relativePath: WorkspaceUploadPath,
    status: Schema.Literal("rejected"),
    reason: TrimmedNonEmptyString,
  }),
]);
export type ProjectPrepareUploadFileResult = typeof ProjectPrepareUploadFileResult.Type;

export const ProjectPrepareUploadResult = Schema.Struct({
  /** One entry per input file, in input order. */
  files: Schema.Array(ProjectPrepareUploadFileResult),
  rejectedDirectories: Schema.Array(
    Schema.Struct({ relativePath: WorkspaceUploadPath, reason: TrimmedNonEmptyString }),
  ),
});
export type ProjectPrepareUploadResult = typeof ProjectPrepareUploadResult.Type;

export class ProjectPrepareUploadError extends Schema.TaggedError<ProjectPrepareUploadError>()(
  "ProjectPrepareUploadError",
  {
    cwd: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
