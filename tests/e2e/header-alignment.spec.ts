import { expect, test } from "@playwright/test";

import { factoryWorkbenchHeaderIsland } from "../../src/views/factory/workbench/page";
import type { FactoryWorkbenchPageModel } from "../../src/views/factory-models";

type HeaderCase = {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly theme: "light" | "dark";
};

const headerCases: ReadonlyArray<HeaderCase> = [
  { name: "narrow light", viewport: { width: 375, height: 800 }, theme: "light" },
  { name: "narrow dark", viewport: { width: 375, height: 800 }, theme: "dark" },
  { name: "wide light", viewport: { width: 1280, height: 800 }, theme: "light" },
  { name: "wide dark", viewport: { width: 1280, height: 800 }, theme: "dark" },
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
      tokensUsed: 1234,
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

for (const headerCase of headerCases) {
  test(`workbench header keeps engineer and token controls aligned in ${headerCase.name}`, async ({ page }) => {
    await page.setViewportSize(headerCase.viewport);
    await page.setContent(
      `<!doctype html>
<html>
  <head></head>
  <body class="dark:bg-background dark:text-foreground">
    ${factoryWorkbenchHeaderIsland(makeHeaderModel())}
  </body>
</html>`,
      { waitUntil: "domcontentloaded" },
    );
    await page.addStyleTag({ path: "dist/assets/factory.css" });
    await page.evaluate((nextTheme) => {
      document.documentElement.classList.toggle("dark", nextTheme === "dark");
      document.body.classList.toggle("dark", nextTheme === "dark");
    }, headerCase.theme);

    const engineerTrigger = page.locator('[data-factory-workbench-header-trigger="engineer"]');
    const tokenCount = page.locator('[data-factory-workbench-header-metric="token-count"]');

    await expect(engineerTrigger).toBeVisible();
    await expect(tokenCount).toBeVisible();

    const engineerBox = await engineerTrigger.boundingBox();
    const tokenBox = await tokenCount.boundingBox();

    expect(engineerBox).not.toBeNull();
    expect(tokenBox).not.toBeNull();
    expect(Math.abs((engineerBox!.y + engineerBox!.height) - (tokenBox!.y + tokenBox!.height))).toBeLessThan(1);
  });
}
