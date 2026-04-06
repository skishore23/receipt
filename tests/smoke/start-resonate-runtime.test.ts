import { expect, test } from "bun:test";

import { serverArgsForRole, shouldWatchRole } from "../../scripts/start-resonate-runtime.mjs";

test("resonate supervisor: default watch mode only watches the api role", () => {
  expect(shouldWatchRole("api", "1")).toBe(true);
  expect(shouldWatchRole("worker-control", "1")).toBe(false);
  expect(serverArgsForRole("api", "1")).toEqual(["--watch", "src/server.ts"]);
  expect(serverArgsForRole("worker-chat", "1")).toEqual(["src/server.ts"]);
});

test("resonate supervisor: explicit all watch mode watches every role", () => {
  expect(shouldWatchRole("driver", "all")).toBe(true);
  expect(shouldWatchRole("worker-codex", "all")).toBe(true);
  expect(serverArgsForRole("worker-codex", "all")).toEqual(["--watch", "src/server.ts"]);
});

test("resonate supervisor: comma-separated watch mode only watches selected roles", () => {
  expect(shouldWatchRole("api", "api,worker-codex")).toBe(true);
  expect(shouldWatchRole("worker-codex", "api,worker-codex")).toBe(true);
  expect(shouldWatchRole("worker-chat", "api,worker-codex")).toBe(false);
  expect(serverArgsForRole("worker-chat", "api,worker-codex")).toEqual(["src/server.ts"]);
});
