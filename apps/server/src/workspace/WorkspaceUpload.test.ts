// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { WORKSPACE_UPLOAD_MAX_FILE_BYTES, WORKSPACE_UPLOAD_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import {
  describeStoreFailure,
  placeExclusive,
  placeUploadedFile,
  prepareWorkspaceUpload,
  storeWorkspaceUpload,
  validateWorkspaceUploadToken,
  withCopySuffix,
} from "./WorkspaceUpload.ts";

const layerTest = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  ServerSecretStore.layer,
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-upload-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-workspace-upload-" });
});

const writeFile = (cwd: string, relativePath: string, contents = "") => {
  const absolutePath = NodePath.join(cwd, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
  NodeFS.writeFileSync(absolutePath, contents);
};

const tokenOf = (relativeUrl: string) =>
  relativeUrl.slice(`${WORKSPACE_UPLOAD_ROUTE_PREFIX}/`.length);

it.layer(layerTest)("WorkspaceUpload.prepare", (it) => {
  it.effect("signs a ready upload URL for a new file and creates its folder", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "docs/report.pdf", sizeBytes: 3, onConflict: "fail" }],
      });

      const [file] = result.files;
      expect(file).toMatchObject({ relativePath: "docs/report.pdf", status: "ready" });
      if (file?.status !== "ready") throw new Error("expected ready");
      expect(NodeFS.statSync(NodePath.join(cwd, "docs")).isDirectory()).toBe(true);
      expect(yield* validateWorkspaceUploadToken(tokenOf(file.relativeUrl))).toMatchObject({
        kind: "workspace-upload",
        cwd,
        relativePath: "docs/report.pdf",
        sizeBytes: 3,
        onConflict: "fail",
      });
    }),
  );

  it.effect("reports taken names as conflicts depending on the conflict mode", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      writeFile(cwd, "a.txt", "old");
      NodeFS.mkdirSync(NodePath.join(cwd, "folder"));

      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [
          { relativePath: "a.txt", sizeBytes: 1, onConflict: "fail" },
          { relativePath: "a.txt", sizeBytes: 1, onConflict: "replace" },
          { relativePath: "folder", sizeBytes: 1, onConflict: "replace" },
          { relativePath: "folder", sizeBytes: 1, onConflict: "keepBoth" },
        ],
      });

      expect(result.files.map((file) => file.status)).toEqual([
        "conflict",
        "ready",
        "conflict",
        "ready",
      ]);
      expect(result.files[0]).toMatchObject({ existingKind: "file" });
      expect(result.files[2]).toMatchObject({ existingKind: "directory" });
    }),
  );

  it.effect(
    "rejects paths outside the project, inside .git, reserved names and oversized files",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const result = yield* prepareWorkspaceUpload({
          cwd,
          directories: [],
          files: [
            { relativePath: "../escape.txt", sizeBytes: 1, onConflict: "fail" },
            { relativePath: NodePath.join(cwd, "absolute.txt"), sizeBytes: 1, onConflict: "fail" },
            { relativePath: ".git/config", sizeBytes: 1, onConflict: "fail" },
            { relativePath: "sub/.git/hooks/x", sizeBytes: 1, onConflict: "fail" },
            { relativePath: "x.t3upload.part", sizeBytes: 1, onConflict: "fail" },
            {
              relativePath: "huge.bin",
              sizeBytes: WORKSPACE_UPLOAD_MAX_FILE_BYTES + 1,
              onConflict: "fail",
            },
          ],
        });
        expect(result.files.every((file) => file.status === "rejected")).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(cwd, ".git"))).toBe(false);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects targets reached through a symlinked folder that leaves the project",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        NodeFS.symlinkSync(outside, NodePath.join(cwd, "link"), "dir");

        const result = yield* prepareWorkspaceUpload({
          cwd,
          directories: ["link/new-folder"],
          files: [{ relativePath: "link/x.txt", sizeBytes: 1, onConflict: "fail" }],
        });
        expect(result.files[0]).toMatchObject({ status: "rejected" });
        expect(result.rejectedDirectories).toHaveLength(1);
        expect(NodeFS.readdirSync(outside)).toEqual([]);
      }),
  );

  it.effect("creates empty folders and reports folders blocked by a file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      writeFile(cwd, "blocker", "file");

      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: ["empty/nested", "blocker/sub"],
        files: [{ relativePath: "blocker/inner.txt", sizeBytes: 1, onConflict: "fail" }],
      });

      expect(NodeFS.statSync(NodePath.join(cwd, "empty/nested")).isDirectory()).toBe(true);
      expect(result.rejectedDirectories).toEqual([
        { relativePath: "blocker/sub", reason: expect.any(String) },
      ]);
      expect(result.files[0]).toMatchObject({ status: "rejected" });
    }),
  );

  it.effect("fails when the project folder does not exist", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const error = yield* prepareWorkspaceUpload({
        cwd: NodePath.join(cwd, "missing"),
        directories: [],
        files: [],
      }).pipe(Effect.flip);
      expect(error._tag).toBe("ProjectPrepareUploadError");
    }),
  );

  it.effect("rejects tampered, malformed and expired tokens", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "a.txt", sizeBytes: 1, onConflict: "fail" }],
      });
      const file = result.files[0];
      if (file?.status !== "ready") throw new Error("expected ready");
      const token = tokenOf(file.relativeUrl);
      const [payload, signature] = token.split(".");

      expect(yield* validateWorkspaceUploadToken(`${payload}x.${signature}`)).toBeNull();
      expect(yield* validateWorkspaceUploadToken(`${token}.extra`)).toBeNull();
      expect(yield* validateWorkspaceUploadToken("garbage")).toBeNull();
      yield* TestClock.adjust("11 minutes");
      expect(yield* validateWorkspaceUploadToken(token)).toBeNull();
    }),
  );

  it.effect("removes part files older than a day from the target folder", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const stale = NodePath.join(cwd, "docs", ".old.pdf.abc.t3upload.part");
      writeFile(cwd, "docs/.old.pdf.abc.t3upload.part", "partial");
      NodeFS.utimesSync(stale, 0, 0);

      yield* TestClock.adjust("25 hours");
      yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "docs/new.pdf", sizeBytes: 1, onConflict: "fail" }],
      });
      expect(NodeFS.existsSync(stale)).toBe(false);
    }),
  );

  it.effect("rejects .git segments regardless of letter case, for files and folders", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: [".git/hooks", ".GIT/hooks"],
        files: [
          { relativePath: ".GIT/config", sizeBytes: 1, onConflict: "fail" },
          { relativePath: "sub/.Git/x", sizeBytes: 1, onConflict: "fail" },
        ],
      });
      expect(result.files.every((file) => file.status === "rejected")).toBe(true);
      expect(result.rejectedDirectories).toHaveLength(2);
      expect(NodeFS.readdirSync(cwd)).toEqual([]);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("rejects targets reached through a symlink to .git", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      NodeFS.mkdirSync(NodePath.join(cwd, ".git"));
      NodeFS.symlinkSync(NodePath.join(cwd, ".git"), NodePath.join(cwd, "g"), "dir");

      const result = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "g/hooks/x", sizeBytes: 1, onConflict: "fail" }],
      });
      expect(result.files[0]).toMatchObject({ status: "rejected" });
      expect(NodeFS.readdirSync(NodePath.join(cwd, ".git"))).toEqual([]);
    }),
  );

  it.effect("keeps fresh part files while removing old ones", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const stale = NodePath.join(cwd, "docs", ".old.abc.t3upload.part");
      const fresh = NodePath.join(cwd, "docs", ".new.abc.t3upload.part");
      writeFile(cwd, "docs/.old.abc.t3upload.part", "partial");
      writeFile(cwd, "docs/.new.abc.t3upload.part", "partial");
      NodeFS.utimesSync(stale, 0, 0);

      yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "docs/new.pdf", sizeBytes: 1, onConflict: "fail" }],
      });
      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(NodeFS.existsSync(fresh)).toBe(true);
    }),
  );
});

describe("withCopySuffix", () => {
  it("numbers the stem and keeps the last extension", () => {
    const dir = NodePath.join("a", "b");
    expect(withCopySuffix(NodePath.join(dir, "report.pdf"), 1)).toBe(
      NodePath.join(dir, "report (1).pdf"),
    );
    expect(withCopySuffix(NodePath.join(dir, "archive.tar.gz"), 2)).toBe(
      NodePath.join(dir, "archive.tar (2).gz"),
    );
    expect(withCopySuffix(NodePath.join(dir, ".env"), 1)).toBe(NodePath.join(dir, ".env (1)"));
    expect(withCopySuffix(NodePath.join(dir, "Makefile"), 3)).toBe(
      NodePath.join(dir, "Makefile (3)"),
    );
  });
});

const prepareOne = (
  cwd: string,
  relativePath: string,
  contents: string,
  onConflict: "fail" | "replace" | "keepBoth",
) =>
  Effect.gen(function* () {
    const result = yield* prepareWorkspaceUpload({
      cwd,
      directories: [],
      files: [{ relativePath, sizeBytes: Buffer.byteLength(contents), onConflict }],
    });
    const file = result.files[0];
    if (file?.status !== "ready") throw new Error(`expected ready, got ${file?.status}`);
    const claims = yield* validateWorkspaceUploadToken(tokenOf(file.relativeUrl));
    if (!claims) throw new Error("expected valid claims");
    return claims;
  });

const bytes = (text: string) => new TextEncoder().encode(text);
const partFilesIn = (directory: string) =>
  NodeFS.readdirSync(directory).filter((name) => name.endsWith(".t3upload.part"));

it.layer(layerTest)("WorkspaceUpload.store", (it) => {
  it.effect("writes a new file and leaves no part file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "docs/a.txt", "hello", "fail");
      expect(yield* storeWorkspaceUpload(claims, bytes("hello"))).toEqual({
        ok: true,
        relativePath: "docs/a.txt",
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "docs/a.txt"), "utf8")).toBe("hello");
      expect(partFilesIn(NodePath.join(cwd, "docs"))).toEqual([]);
    }),
  );

  it.effect("stores a streamed zero-byte file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "empty.txt", "", "fail");
      expect(yield* storeWorkspaceUpload(claims, Stream.empty)).toEqual({
        ok: true,
        relativePath: "empty.txt",
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "empty.txt"), "utf8")).toBe("");
    }),
  );

  it.effect("returns a conflict when the target appears during the upload", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "a.txt", "new", "fail");
      writeFile(cwd, "a.txt", "written by an agent");
      expect(yield* storeWorkspaceUpload(claims, bytes("new"))).toMatchObject({
        ok: false,
        status: 409,
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "a.txt"), "utf8")).toBe("written by an agent");
      expect(partFilesIn(cwd)).toEqual([]);
    }),
  );

  it.effect("replaces an existing file when asked to", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      writeFile(cwd, "a.txt", "old");
      const claims = yield* prepareOne(cwd, "a.txt", "new", "replace");
      expect(yield* storeWorkspaceUpload(claims, bytes("new"))).toEqual({
        ok: true,
        relativePath: "a.txt",
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "a.txt"), "utf8")).toBe("new");
    }),
  );

  it.effect("keeps both by numbering the new file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      writeFile(cwd, "r.pdf", "one");
      writeFile(cwd, "r (1).pdf", "two");
      const claims = yield* prepareOne(cwd, "r.pdf", "three", "keepBoth");
      expect(yield* storeWorkspaceUpload(claims, bytes("three"))).toEqual({
        ok: true,
        relativePath: "r (2).pdf",
      });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "r.pdf"), "utf8")).toBe("one");
      expect(NodeFS.readFileSync(NodePath.join(cwd, "r (2).pdf"), "utf8")).toBe("three");
    }),
  );

  it.effect("keeps a folder and stores the file next to it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      NodeFS.mkdirSync(NodePath.join(cwd, "data"));
      const claims = yield* prepareOne(cwd, "data", "x", "keepBoth");
      expect(yield* storeWorkspaceUpload(claims, bytes("x"))).toEqual({
        ok: true,
        relativePath: "data (1)",
      });
      expect(NodeFS.statSync(NodePath.join(cwd, "data")).isDirectory()).toBe(true);
    }),
  );

  it.effect("rejects a body whose size does not match and cleans up", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "a.txt", "hello", "fail");
      expect(yield* storeWorkspaceUpload(claims, Stream.make(bytes("hello world")))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(yield* storeWorkspaceUpload(claims, Stream.make(bytes("hi")))).toMatchObject({
        ok: false,
        status: 400,
      });
      expect(NodeFS.existsSync(NodePath.join(cwd, "a.txt"))).toBe(false);
      expect(partFilesIn(cwd)).toEqual([]);
    }),
  );

  it.effect("removes the part file when the body stream fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "a.txt", "hello", "fail");
      const broken = Stream.concat(
        Stream.make(bytes("he")),
        Stream.fail(new Error("connection reset")),
      );
      expect(yield* storeWorkspaceUpload(claims, broken)).toMatchObject({
        ok: false,
        status: 500,
      });
      expect(partFilesIn(cwd)).toEqual([]);
      expect(NodeFS.existsSync(NodePath.join(cwd, "a.txt"))).toBe(false);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "replaces a symlinked target without writing through it",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        writeFile(outside, "secret.txt", "outside");
        NodeFS.symlinkSync(NodePath.join(outside, "secret.txt"), NodePath.join(cwd, "link.txt"));
        const claims = yield* prepareOne(cwd, "link.txt", "inside", "replace");
        expect(yield* storeWorkspaceUpload(claims, bytes("inside"))).toEqual({
          ok: true,
          relativePath: "link.txt",
        });
        expect(NodeFS.readFileSync(NodePath.join(outside, "secret.txt"), "utf8")).toBe("outside");
        expect(NodeFS.lstatSync(NodePath.join(cwd, "link.txt")).isSymbolicLink()).toBe(false);
      }),
  );

  it.effect("rejects with 403 when the path stopped being allowed after signing", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir;
      const claims = yield* prepareOne(cwd, "a.txt", "x", "fail");
      expect(
        yield* storeWorkspaceUpload({ ...claims, relativePath: ".git/config" }, bytes("x")),
      ).toMatchObject({ ok: false, status: 403 });
    }),
  );
});

describe("placeUploadedFile", () => {
  const withTempDir = async (run: (dir: string) => Promise<void>) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-place-"));
    try {
      await run(dir);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reports a conflict instead of replacing a folder", async () => {
    await withTempDir(async (dir) => {
      NodeFS.mkdirSync(NodePath.join(dir, "target"));
      NodeFS.writeFileSync(NodePath.join(dir, "part"), "x");
      await expect(
        placeUploadedFile(NodePath.join(dir, "part"), NodePath.join(dir, "target"), "replace"),
      ).resolves.toEqual({ status: "conflict" });
    });
  });

  it.skipIf(!symlinksSupported)(
    "reports a conflict instead of replacing a directory symlink",
    async () => {
      await withTempDir(async (dir) => {
        NodeFS.mkdirSync(NodePath.join(dir, "real"));
        NodeFS.symlinkSync(NodePath.join(dir, "real"), NodePath.join(dir, "link"), "junction");
        NodeFS.writeFileSync(NodePath.join(dir, "part"), "x");
        await expect(
          placeUploadedFile(NodePath.join(dir, "part"), NodePath.join(dir, "link"), "replace"),
        ).resolves.toEqual({ status: "conflict" });
        expect(NodeFS.statSync(NodePath.join(dir, "real")).isDirectory()).toBe(true);
      });
    },
  );
});

describe("placeExclusive fallback cleanup", () => {
  const nodeError = (code: string) => Object.assign(new Error(code), { code });

  it("removes the reserved empty file when the move fails", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-excl-"));
    try {
      NodeFS.writeFileSync(NodePath.join(dir, "part"), "x");
      const target = NodePath.join(dir, "target.txt");
      await expect(
        placeExclusive(NodePath.join(dir, "part"), target, {
          ...NodeFSP,
          link: () => Promise.reject(nodeError("EISDIR")),
          rename: () => Promise.reject(nodeError("EBUSY")),
        }),
      ).rejects.toMatchObject({ code: "EBUSY" });
      expect(NodeFS.existsSync(target)).toBe(false);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports success when removing the part file after a link fails", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-excl-"));
    try {
      NodeFS.writeFileSync(NodePath.join(dir, "part"), "x");
      const target = NodePath.join(dir, "target.txt");
      await expect(
        placeExclusive(NodePath.join(dir, "part"), target, {
          ...NodeFSP,
          rm: () => Promise.reject(nodeError("EBUSY")),
        }),
      ).resolves.toBe(true);
      expect(NodeFS.readFileSync(target, "utf8")).toBe("x");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeStoreFailure", () => {
  it("maps a full disk to 507, also when wrapped", () => {
    const enospc = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    expect(describeStoreFailure(enospc).status).toBe(507);
    expect(describeStoreFailure({ cause: { cause: enospc } })).toEqual({
      status: 507,
      detail: "The host's disk is full.",
    });
  });

  it("keeps other failures generic", () => {
    expect(describeStoreFailure(new Error("boom"))).toEqual({
      status: 500,
      detail: "Failed to write the uploaded file.",
    });
  });
});
