// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import { prepareWorkspaceUpload } from "./workspace/WorkspaceUpload.ts";

const layerTest = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  ServerSecretStore.layer,
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-upload-route-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeClient = Effect.gen(function* () {
  const services = yield* Layer.build(
    HttpRouter.serve(ServerHttp.layerWorkspaceUploadRoute, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  return Context.get(services, HttpClient.HttpClient);
});

const post = (url: string, body: Uint8Array) =>
  HttpClientRequest.make("POST")(url, {
    body: HttpBody.uint8Array(body, "application/octet-stream"),
  });

it.layer(layerTest)("workspace upload route", (it) => {
  it.effect("stores the posted bytes and answers with the final path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upload-route-cwd-" });
      const prepared = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "docs/hello.txt", sizeBytes: 5, onConflict: "fail" }],
      });
      const file = prepared.files[0];
      if (file?.status !== "ready") throw new Error("expected ready");
      const client = yield* makeClient;

      const response = yield* client.execute(
        post(file.relativeUrl, new TextEncoder().encode("hello")),
      );
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("docs/hello.txt");
      expect(NodeFS.readFileSync(NodePath.join(cwd, "docs/hello.txt"), "utf8")).toBe("hello");
    }),
  );

  it.effect("answers 400 when the body size differs from the signed size", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-upload-route-cwd-" });
      const prepared = yield* prepareWorkspaceUpload({
        cwd,
        directories: [],
        files: [{ relativePath: "a.txt", sizeBytes: 5, onConflict: "fail" }],
      });
      const file = prepared.files[0];
      if (file?.status !== "ready") throw new Error("expected ready");
      const client = yield* makeClient;

      const response = yield* client.execute(
        post(file.relativeUrl, new TextEncoder().encode("hi")),
      );
      expect(response.status).toBe(400);
      expect(NodeFS.existsSync(NodePath.join(cwd, "a.txt"))).toBe(false);
    }),
  );

  it.effect("answers 404 for an unknown token", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const response = yield* client.execute(
        post("/api/projects/upload/not.valid", new Uint8Array([1])),
      );
      expect(response.status).toBe(404);
    }),
  );
});
