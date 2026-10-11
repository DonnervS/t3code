// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  WORKSPACE_UPLOAD_MAX_FILE_BYTES,
  WORKSPACE_UPLOAD_ROUTE_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { prepareWorkspaceUpload, validateWorkspaceUploadToken } from "./WorkspaceUpload.ts";

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

  it.effect("rejects paths outside the project, inside .git, reserved names and oversized files", () =>
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
});
