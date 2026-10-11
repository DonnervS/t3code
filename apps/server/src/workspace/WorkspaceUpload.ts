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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";

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

/** Case-insensitive: the project may live on a case-insensitive filesystem. */
function hasGitSegment(segments: ReadonlyArray<string>): boolean {
  return segments.some((segment) => segment.toLowerCase() === ".git");
}

// Device names, with or without an extension ("nul.txt" is the NUL device too).
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(\..*)?$/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"|?*\\]/;

/**
 * Whether one path segment can be created as a file or folder name on `platform`.
 * Names from a Mac ("AC:DC.mp3") are often invalid on Windows; rejecting them at prepare
 * beats failing with a generic error after the whole file was sent.
 */
export function isValidHostFileName(segment: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return true;
  return !(
    WINDOWS_INVALID_CHARACTER.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) < 32) ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_RESERVED_NAME.test(segment)
  );
}

/**
 * The nearest existing ancestor of `absolutePath` must resolve inside the real
 * workspace root, and not into a `.git` folder reached through a symlink.
 */
async function isInsideRealRoot(realRoot: string, absolutePath: string): Promise<boolean> {
  let candidate = NodePath.dirname(absolutePath);
  for (;;) {
    try {
      const relative = NodePath.relative(realRoot, await NodeFSP.realpath(candidate));
      return (
        !(
          relative === ".." ||
          relative.startsWith(`..${NodePath.sep}`) ||
          NodePath.isAbsolute(relative)
        ) && !hasGitSegment(relative.split(NodePath.sep))
      );
    } catch (cause) {
      const parent = NodePath.dirname(candidate);
      if (!isNodeError(cause, "ENOENT") || parent === candidate) return false;
      candidate = parent;
    }
  }
}

/**
 * `WorkspacePaths.resolveRelativePathWithinRoot` without its trimming: " notes.txt" is a
 * real name and must never land on "notes.txt".
 */
function resolveWithinRoot(
  cwd: string,
  relativePath: string,
): { absolutePath: string; relativePath: string } | null {
  if (NodePath.isAbsolute(relativePath)) return null;
  const absolutePath = NodePath.resolve(cwd, relativePath);
  const relativeToRoot = toPosixPath(NodePath.relative(cwd, absolutePath));
  if (
    relativeToRoot === "" ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith("../") ||
    NodePath.isAbsolute(relativeToRoot)
  ) {
    return null;
  }
  return { absolutePath, relativePath: relativeToRoot };
}

export const resolveUploadTarget = Effect.fn("WorkspaceUpload.resolveTarget")(function* (
  realRoot: string,
  cwd: string,
  relativePath: string,
) {
  const resolved = resolveWithinRoot(cwd, relativePath);
  if (resolved === null) return rejectTarget("Outside the project folder.");
  if (hasGitSegment(resolved.relativePath.split("/"))) {
    return rejectTarget("Uploads into .git are not allowed.");
  }
  // The input's own segments: on Windows, resolving already split a "\" inside a name.
  const platform = yield* HostProcess.Platform;
  const names = relativePath.split("/").filter((name) => !["", ".", ".."].includes(name));
  if (!names.every((name) => isValidHostFileName(name, platform))) {
    return rejectTarget("Not a valid file name on the host (Windows).");
  }
  if (NodePath.basename(resolved.absolutePath).endsWith(WORKSPACE_UPLOAD_PART_SUFFIX)) {
    return rejectTarget("This file name is reserved for uploads in progress.");
  }
  const inside = yield* Effect.promise(() => isInsideRealRoot(realRoot, resolved.absolutePath));
  if (!inside) return rejectTarget("Outside the project folder.");
  return { ok: true, ...resolved } satisfies UploadTarget as UploadTarget;
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
  let entries;
  try {
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    return; // Best effort: a failed sweep must not block the upload.
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(WORKSPACE_UPLOAD_PART_SUFFIX)) continue;
    const partPath = NodePath.join(directory, entry.name);
    try {
      const { mtimeMs } = await NodeFSP.stat(partPath);
      if (nowMs - mtimeMs >= STALE_PART_AGE_MS) await NodeFSP.rm(partPath, { force: true });
    } catch {
      // One entry failing (e.g. removed concurrently) must not skip the rest.
    }
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

  const rejectedDirectories: Array<ProjectPrepareUploadResult["rejectedDirectories"][number]> = [];
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

const KEEP_BOTH_MAX_ATTEMPTS = 1000;
// Filesystems without hard links (FAT/exFAT, some network shares) report one of these.
// exFAT on Windows reports EISDIR for every link attempt. The fallback below is exclusive too.
const LINK_UNSUPPORTED_CODES = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EISDIR"];
// What renaming a file over a folder, folder symlink or junction fails with (Windows: EPERM).
const RENAME_OVER_DIRECTORY_CODES = ["EPERM", "EISDIR", "EEXIST", "EACCES", "ENOTEMPTY"];
// On Windows, antivirus scanners and indexers briefly hold new or replaced files open.
const LOCKED_FILE_CODES = ["EPERM", "EBUSY", "EACCES"];
// Five attempts, 750 ms of waiting in all.
const LOCKED_FILE_RETRY_DELAYS_MS = [50, 100, 200, 400];

/** File operations that place an upload; a test seam for failures that are hard to provoke. */
export type PlaceOps = Pick<typeof NodeFSP, "link" | "open" | "rename" | "rm" | "unlink"> & {
  readonly sleep?: (ms: number) => Promise<void>;
};

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isLockedFileError = (cause: unknown) =>
  LOCKED_FILE_CODES.some((code) => isNodeError(cause, code));

/** Runs `operation` again while the file is locked by another process, a few times at most. */
async function retryWhileLocked<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = sleepMs,
): Promise<T> {
  for (const delay of LOCKED_FILE_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch (cause) {
      if (!isLockedFileError(cause)) throw cause;
      await sleep(delay);
    }
  }
  return operation();
}

/** Removes a part file, waiting out a scanner that still holds it. Never fails. */
async function removePartFile(partPath: string, ops: PlaceOps = NodeFSP): Promise<void> {
  await retryWhileLocked(() => ops.rm(partPath, { force: true }), ops.sleep).catch(() => undefined);
}

/** `report.pdf` -> `report (1).pdf`; `.env` -> `.env (1)`; `Makefile` -> `Makefile (1)`. */
export function withCopySuffix(filePath: string, copy: number): string {
  const name = NodePath.basename(filePath);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return NodePath.join(NodePath.dirname(filePath), `${stem} (${copy})${extension}`);
}

/**
 * Moves the part file to `targetPath` only if that name is still free. A hard
 * link fails atomically with EEXIST, so a file an agent writes meanwhile wins.
 */
export async function placeExclusive(
  partPath: string,
  targetPath: string,
  ops: PlaceOps = NodeFSP,
): Promise<boolean> {
  try {
    await ops.link(partPath, targetPath);
  } catch (cause) {
    if (isNodeError(cause, "EEXIST")) return false;
    if (!LINK_UNSUPPORTED_CODES.some((code) => isNodeError(cause, code))) throw cause;
    // No hard links here: reserve the name exclusively, then move the bytes over it.
    try {
      await (await ops.open(targetPath, "wx")).close();
    } catch (reserveCause) {
      if (["EEXIST", "EISDIR", "EPERM"].some((code) => isNodeError(reserveCause, code))) {
        return false;
      }
      throw reserveCause;
    }
    try {
      await ops.rename(partPath, targetPath);
    } catch (moveCause) {
      // The exclusive create proved the name was ours, so don't leave an empty file behind.
      await ops.unlink(targetPath).catch(() => undefined);
      throw moveCause;
    }
    return true;
  }
  // The file is stored already; the caller removes the part file if this fails.
  await removePartFile(partPath, ops);
  return true;
}

/** Following links: a rename onto a folder symlink or junction fails, so treat it like a folder. */
async function isDirectoryOrDirectoryLink(absolutePath: string): Promise<boolean> {
  try {
    return (await NodeFSP.stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

export type PlaceUploadResult =
  | { readonly status: "stored"; readonly absolutePath: string }
  | { readonly status: "conflict" }
  /** Another process kept the file to replace locked. */
  | { readonly status: "inUse" };

async function replaceFile(
  partPath: string,
  targetPath: string,
  ops: PlaceOps,
): Promise<PlaceUploadResult> {
  if (await isDirectoryOrDirectoryLink(targetPath)) return { status: "conflict" };
  for (let attempt = 0; ; attempt++) {
    try {
      // rename replaces a file (or a symlink itself, never its target) on every platform.
      await ops.rename(partPath, targetPath);
      return { status: "stored", absolutePath: targetPath };
    } catch (cause) {
      // A folder may have taken the name since the check above.
      if (
        RENAME_OVER_DIRECTORY_CODES.some((code) => isNodeError(cause, code)) &&
        (await isDirectoryOrDirectoryLink(targetPath))
      ) {
        return { status: "conflict" };
      }
      if (!isLockedFileError(cause)) throw cause;
      const delay = LOCKED_FILE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return { status: "inUse" };
      await (ops.sleep ?? sleepMs)(delay);
    }
  }
}

export async function placeUploadedFile(
  partPath: string,
  targetPath: string,
  mode: typeof WorkspaceUploadConflictMode.Type,
  ops: PlaceOps = NodeFSP,
): Promise<PlaceUploadResult> {
  if (mode === "replace") return replaceFile(partPath, targetPath, ops);
  const attempts = mode === "keepBoth" ? KEEP_BOTH_MAX_ATTEMPTS : 1;
  for (let copy = 0; copy < attempts; copy++) {
    const candidate = copy === 0 ? targetPath : withCopySuffix(targetPath, copy);
    if (await placeExclusive(partPath, candidate, ops)) {
      return { status: "stored", absolutePath: candidate };
    }
  }
  return { status: "conflict" };
}

function hasErrorCode(cause: unknown, code: string, depth = 0): boolean {
  if (typeof cause !== "object" || cause === null || depth > 5) return false;
  return (
    isNodeError(cause, code) ||
    ["cause", "reason"].some((key) =>
      hasErrorCode((cause as Record<string, unknown>)[key], code, depth + 1),
    )
  );
}

/** Status and user-facing detail for an unexpected failure while storing. */
export function describeStoreFailure(cause: unknown): { status: number; detail: string } {
  return hasErrorCode(cause, "ENOSPC")
    ? { status: 507, detail: "The host's disk is full." }
    : { status: 500, detail: "Failed to write the uploaded file." };
}

export type StoreWorkspaceUploadResult =
  | { readonly ok: true; readonly relativePath: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

export const storeWorkspaceUpload = Effect.fn("WorkspaceUpload.store")(function* (
  claims: WorkspaceUploadClaims,
  body: Uint8Array | Stream.Stream<Uint8Array, unknown>,
) {
  if (body instanceof Uint8Array && body.byteLength !== claims.sizeBytes) {
    return {
      ok: false,
      status: 400,
      detail: `Body was ${body.byteLength} bytes, expected ${claims.sizeBytes}.`,
    } satisfies StoreWorkspaceUploadResult;
  }

  const realRoot = yield* Effect.promise(() => NodeFSP.realpath(claims.cwd).catch(() => null));
  if (realRoot === null) {
    return {
      ok: false,
      status: 404,
      detail: "The project folder no longer exists.",
    } satisfies StoreWorkspaceUploadResult;
  }
  // The project may have changed since the URL was signed, so check the path again.
  const target = yield* resolveUploadTarget(realRoot, claims.cwd, claims.relativePath);
  if (!target.ok) {
    return {
      ok: false,
      status: 403,
      detail: target.reason,
    } satisfies StoreWorkspaceUploadResult;
  }

  const crypto = yield* Crypto.Crypto;
  const partId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const directory = NodePath.dirname(target.absolutePath);
  const partPath = NodePath.join(
    directory,
    `.${NodePath.basename(target.absolutePath)}.${partId}${WORKSPACE_UPLOAD_PART_SUFFIX}`,
  );
  const fileSystem = yield* FileSystem.FileSystem;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  let receivedBytes = 0;
  const bodyStream = body instanceof Uint8Array ? Stream.make(body) : body;

  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* Stream.run(
      bodyStream.pipe(
        Stream.takeWhile((chunk) => {
          receivedBytes += chunk.byteLength;
          return receivedBytes <= claims.sizeBytes;
        }),
      ),
      fileSystem.sink(partPath),
    );
    if (receivedBytes !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${receivedBytes} bytes, expected ${claims.sizeBytes}.`,
      } satisfies StoreWorkspaceUploadResult;
    }
    // Not interruptible: cleanup must not delete the part file while placement is running.
    const placed = yield* Effect.uninterruptible(
      Effect.tryPromise(() => placeUploadedFile(partPath, target.absolutePath, claims.onConflict)),
    );
    if (placed.status === "conflict") {
      return {
        ok: false,
        status: 409,
        detail: "A file or folder with this name appeared while uploading.",
      } satisfies StoreWorkspaceUploadResult;
    }
    if (placed.status === "inUse") {
      return {
        ok: false,
        status: 423,
        detail: "The file is in use on the host.",
      } satisfies StoreWorkspaceUploadResult;
    }
    yield* workspaceEntries.refresh(claims.cwd);
    return {
      ok: true,
      relativePath: toPosixPath(NodePath.relative(claims.cwd, placed.absolutePath)),
    } satisfies StoreWorkspaceUploadResult;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("Failed to store workspace upload.", {
        relativePath: claims.relativePath,
        cause,
      }).pipe(
        Effect.as({
          ok: false,
          ...describeStoreFailure(cause),
        } satisfies StoreWorkspaceUploadResult),
      ),
    ),
    Effect.ensuring(Effect.promise(() => removePartFile(partPath))),
  );
});
