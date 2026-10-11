// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceUpload - files dropped on the file tree, written into the project folder.
 *
 * `prepareWorkspaceUpload` checks each target and signs one short-lived upload URL
 * per file; the bytes then arrive over HTTP (`layerWorkspaceUploadRoute` in
 * `http.ts`). Same split as chat attachments in `assets/AttachmentUpload.ts`.
 *
 * @module WorkspaceUpload
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ProjectPrepareUploadError,
  type ProjectPrepareUploadFileResult,
  type ProjectPrepareUploadInput,
  type ProjectPrepareUploadResult,
  WORKSPACE_UPLOAD_MAX_FILE_BYTES,
  WORKSPACE_UPLOAD_PART_SUFFIX,
  WORKSPACE_UPLOAD_ROUTE_PREFIX,
  WORKSPACE_UPLOAD_URL_TTL_MS,
  WorkspaceUploadConflictMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

// Shared with asset and attachment tokens; the signed `kind` keeps them apart.
const SIGNING_SECRET_NAME = "asset-access-signing-key";
const STALE_PART_AGE_MS = 24 * 60 * 60_000;

const WorkspaceUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace-upload"),
  cwd: Schema.String,
  relativePath: Schema.String,
  sizeBytes: Schema.Number,
  onConflict: WorkspaceUploadConflictMode,
  expiresAt: Schema.Number,
});
export type WorkspaceUploadClaims = typeof WorkspaceUploadClaims.Type;

const workspaceUploadClaimsJson = Schema.fromJsonString(WorkspaceUploadClaims);
const decodeWorkspaceUploadClaims = Schema.decodeUnknownOption(workspaceUploadClaimsJson);
const encodeWorkspaceUploadClaims = Schema.encodeSync(workspaceUploadClaimsJson);

export function isNodeError(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

export function toPosixPath(value: string): string {
  return value.split(NodePath.sep).join("/");
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

export type UploadTarget =
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly reason: string };

const rejectTarget = (reason: string): UploadTarget => ({ ok: false, reason });

/**
 * The nearest existing ancestor of `absolutePath` must resolve inside the real
 * workspace root, so a symlinked folder cannot carry an upload out of the project.
 */
async function isInsideRealRoot(realRoot: string, absolutePath: string): Promise<boolean> {
  let candidate = NodePath.dirname(absolutePath);
  for (;;) {
    try {
      const relative = NodePath.relative(realRoot, await NodeFSP.realpath(candidate));
      return !(
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative)
      );
    } catch (cause) {
      const parent = NodePath.dirname(candidate);
      if (!isNodeError(cause, "ENOENT") || parent === candidate) return false;
      candidate = parent;
    }
  }
}

export const resolveUploadTarget = Effect.fn("WorkspaceUpload.resolveTarget")(function* (
  realRoot: string,
  cwd: string,
  relativePath: string,
) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const resolved = yield* workspacePaths
    .resolveRelativePathWithinRoot({ workspaceRoot: cwd, relativePath })
    .pipe(Effect.option);
  if (Option.isNone(resolved)) return rejectTarget("Outside the project folder.");
  if (resolved.value.relativePath.split("/").includes(".git")) {
    return rejectTarget("Uploads into .git are not allowed.");
  }
  if (NodePath.basename(resolved.value.absolutePath).endsWith(WORKSPACE_UPLOAD_PART_SUFFIX)) {
    return rejectTarget("This file name is reserved for uploads in progress.");
  }
  const inside = yield* Effect.promise(() =>
    isInsideRealRoot(realRoot, resolved.value.absolutePath),
  );
  if (!inside) return rejectTarget("Outside the project folder.");
  return { ok: true, ...resolved.value } satisfies UploadTarget as UploadTarget;
});

/** `null` when nothing is there. Unreadable entries count as files, so they show as conflicts. */
export async function existingKind(absolutePath: string): Promise<"file" | "directory" | null> {
  try {
    return (await NodeFSP.lstat(absolutePath)).isDirectory() ? "directory" : "file";
  } catch (cause) {
    return isNodeError(cause, "ENOENT") ? null : "file";
  }
}

/** `null` on success, otherwise a reason for the user. */
async function makeDirectory(absolutePath: string): Promise<string | null> {
  try {
    await NodeFSP.mkdir(absolutePath, { recursive: true });
    return null;
  } catch (cause) {
    return isNodeError(cause, "EEXIST") || isNodeError(cause, "ENOTDIR")
      ? "A file with that name is in the way."
      : cause instanceof Error
        ? cause.message
        : "Failed to create the folder.";
  }
}

/** Uploads that died with the server leave part files; clear old ones in folders we touch. */
async function sweepStaleParts(directory: string, nowMs: number): Promise<void> {
  try {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(WORKSPACE_UPLOAD_PART_SUFFIX)) continue;
      const partPath = NodePath.join(directory, entry.name);
      const { mtimeMs } = await NodeFSP.stat(partPath);
      if (nowMs - mtimeMs >= STALE_PART_AGE_MS) await NodeFSP.rm(partPath, { force: true });
    }
  } catch {
    // Best effort: a failed sweep must not block the upload.
  }
}

export const prepareWorkspaceUpload = Effect.fn("WorkspaceUpload.prepare")(function* (
  input: ProjectPrepareUploadInput,
) {
  const realRoot = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(input.cwd),
    catch: (cause) =>
      new ProjectPrepareUploadError({
        cwd: input.cwd,
        message: `The project folder '${input.cwd}' is not available.`,
        cause,
      }),
  });
  const secret = yield* loadSigningSecret.pipe(
    Effect.mapError(
      (cause) =>
        new ProjectPrepareUploadError({
          cwd: input.cwd,
          message: "Failed to load the upload signing key.",
          cause,
        }),
    ),
  );
  const nowMs = yield* Clock.currentTimeMillis;
  const expiresAt = nowMs + WORKSPACE_UPLOAD_URL_TTL_MS;

  const rejectedDirectories: Array<ProjectPrepareUploadResult["rejectedDirectories"][number]> =
    [];
  for (const relativePath of input.directories) {
    const target = yield* resolveUploadTarget(realRoot, input.cwd, relativePath);
    const reason = target.ok
      ? yield* Effect.promise(() => makeDirectory(target.absolutePath))
      : target.reason;
    if (reason !== null) rejectedDirectories.push({ relativePath, reason });
  }

  const sweptDirectories = new Set<string>();
  const files: Array<ProjectPrepareUploadFileResult> = [];
  for (const file of input.files) {
    const reject = (reason: string) =>
      files.push({ relativePath: file.relativePath, status: "rejected", reason });
    if (file.sizeBytes > WORKSPACE_UPLOAD_MAX_FILE_BYTES) {
      reject("Larger than the 2 GB upload limit.");
      continue;
    }
    const target = yield* resolveUploadTarget(realRoot, input.cwd, file.relativePath);
    if (!target.ok) {
      reject(target.reason);
      continue;
    }
    const directory = NodePath.dirname(target.absolutePath);
    const directoryError = yield* Effect.promise(() => makeDirectory(directory));
    if (directoryError !== null) {
      reject(directoryError);
      continue;
    }
    if (!sweptDirectories.has(directory)) {
      sweptDirectories.add(directory);
      yield* Effect.promise(() => sweepStaleParts(directory, nowMs));
    }
    const existing = yield* Effect.promise(() => existingKind(target.absolutePath));
    // A folder can only be kept next to, never replaced by, an uploaded file.
    if (
      (existing === "file" && file.onConflict === "fail") ||
      (existing === "directory" && file.onConflict !== "keepBoth")
    ) {
      files.push({ relativePath: file.relativePath, status: "conflict", existingKind: existing });
      continue;
    }
    const encodedPayload = base64UrlEncode(
      encodeWorkspaceUploadClaims({
        version: 1,
        kind: "workspace-upload",
        cwd: input.cwd,
        relativePath: target.relativePath,
        sizeBytes: file.sizeBytes,
        onConflict: file.onConflict,
        expiresAt,
      }),
    );
    files.push({
      relativePath: file.relativePath,
      status: "ready",
      relativeUrl: `${WORKSPACE_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
      expiresAt,
    });
  }

  return { files, rejectedDirectories } satisfies ProjectPrepareUploadResult;
});

export const validateWorkspaceUploadToken = Effect.fn("WorkspaceUpload.validateToken")(function* (
  token: string,
) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) return null;

  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the workspace upload signing key.", { cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
    return null;
  }

  let claims: WorkspaceUploadClaims | null;
  try {
    claims = Option.getOrNull(decodeWorkspaceUploadClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    claims = null;
  }
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});
