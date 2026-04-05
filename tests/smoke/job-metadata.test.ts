import { expect, test } from "bun:test";

import { shouldPublishProfileBoardForJobChange } from "../../src/server/job-metadata";

test("profile-board refresh ignores objective-scoped queue job updates", () => {
  expect(shouldPublishProfileBoardForJobChange({
    payload: {
      kind: "factory.task.run",
      profileId: "generalist",
      objectiveId: "objective_demo",
    },
    result: {
      progressAt: Date.now(),
    },
  })).toBe(false);
});

test("profile-board refresh still publishes for profile-scoped chat jobs", () => {
  expect(shouldPublishProfileBoardForJobChange({
    payload: {
      kind: "factory.run",
      profileId: "generalist",
      stream: "factory/chat/demo",
    },
  })).toBe(true);
});

test("profile-board refresh ignores jobs with no profile binding", () => {
  expect(shouldPublishProfileBoardForJobChange({
    payload: {
      kind: "factory.task.run",
      objectiveId: "objective_demo",
    },
  })).toBe(false);
});
