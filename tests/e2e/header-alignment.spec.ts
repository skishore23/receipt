import { expect, test } from "bun:test";

import { factoryWorkbenchHeaderIsland } from "../../src/views/factory/workbench/page";
import type { FactoryWorkbenchPageModel } from "../../src/views/factory-models";

type HeaderCase = {
  readonly name: string;
  readonly width: number;
  readonly theme: "light" | "dark";
};

const headerCases: ReadonlyArray<HeaderCase> = [
  { name: "narrow light", width: 375, theme: "light" },
  { name: "narrow dark", width: 375, theme: "dark" },
  { name: "wide light", width: 1280, theme: "light" },
  { name: "wide dark", width: 1280, theme: "dark" },
];

const makeHeaderModel = (): FactoryWorkbenchPageModel => ({
  activeProfileId: "software",
  activeProfileLabel: "Software",
  chatId: "chat_demo",
  detailTab: "action",
  filter: "objective.running",
  profiles: [
    {
      id: "software",
      label: "Software",
      href: "/factory?profile=software&chat=chat_demo",
      selected: true,
    },
    {
      id: "generalist",
      label: "Generalist",
      href: "/factory?profile=generalist&chat=chat_demo",
      selected: false,
    },
  ],
  workspace: {
    activeProfileId: "software",
    activeProfileLabel: "Software",
    detailTab: "action",
    filter: "objective.running",
    filters: [],
    selectedObjective: {
      objectiveId: "objective_demo",
      title: "Rebalance workbench header",
      status: "executing",
      phase: "executing",
      displayState: "Running",
      debugLink: "/factory/debug/objective_demo",
      receiptsLink: "/receipt?stream=factory/objectives/objective_demo",
      activeTaskCount: 2,
      taskCount: 5,
    },
    board: {
      objectives: [],
      sections: {
        needs_attention: [],
        active: [],
        queued: [],
        completed: [],
      },
    },
    activeObjectives: [],
    pastObjectives: [],
    blocks: [],
  },
  chat: {
    activeProfileId: "software",
    activeProfileLabel: "Software",
    activeProfilePrimaryRole: "Software engineer",
    items: [],
  },
});

const assertHeaderBaselineContract = (markup: string): void => {
  expect(markup).toContain('data-factory-workbench-header-trigger="engineer"');
  expect(markup).toContain('data-factory-workbench-header-metric="token-count"');
  expect(markup).toContain("items-baseline");
  expect(markup).toContain("items-center gap-x-2 gap-y-0 text-[11px] text-muted-foreground");
  expect(markup).toContain('data-factory-profile-select="true"');
  expect(markup).toContain("Switch engineer");
};

for (const headerCase of headerCases) {
  test(`workbench header keeps engineer and token controls aligned in ${headerCase.name}`, () => {
    const markup = factoryWorkbenchHeaderIsland(makeHeaderModel());

    assertHeaderBaselineContract(markup);
    expect(markup).toContain("2/5 tasks");
    expect(markup).toContain("Tokens");
    expect(markup).toContain("Software engineer");
    expect(markup).toContain("Rebalance workbench header");
    expect(headerCase.width).toBeGreaterThanOrEqual(375);
    expect(headerCase.theme === "light" || headerCase.theme === "dark").toBe(true);
  });
}
