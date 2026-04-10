import { expect, test } from "bun:test";

import { loadFactoryHelperContext } from "../../src/services/factory-helper-catalog";

test("factory helper catalog: exposure prompts prioritize exposure helpers over generic cost helpers", async () => {
  const context = await loadFactoryHelperContext({
    profileRoot: process.cwd(),
    provider: "aws",
    objectiveTitle: "Internet exposure correlation rerun",
    objectivePrompt: "Investigate current internet exposure posture across the active AWS estate, correlate exposed resources or policies with concrete AWS evidence, and conclude with the specific currently exposed surfaces, evidence for each, and any uncertainty or gaps.",
    taskTitle: "Internet exposure correlation rerun",
    taskPrompt: "Correlate internet-exposed resources and policies with direct AWS evidence.",
    domain: "infrastructure",
  });

  expect(context?.selectedHelpers[0]?.id).toBe("aws_internet_exposure_inventory");
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_policy_or_exposure_check")).toBe(true);
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_cdn_charge_investigation")).toBe(false);
});

test("factory helper catalog: ECS degradation prompts prioritize ECS-on-EC2 helper over generic inventory", async () => {
  const context = await loadFactoryHelperContext({
    profileRoot: process.cwd(),
    provider: "aws",
    objectiveTitle: "ECS degradation closure",
    objectivePrompt: "Investigate whether any ECS services on EC2 are currently degraded. Use the checked-in helpers first and conclude whether there is any active degradation right now.",
    taskTitle: "ECS degradation closure",
    taskPrompt: "Use helper-first ECS-on-EC2 evidence collection and conclude whether there is current degradation.",
    domain: "infrastructure",
  });

  expect(context?.selectedHelpers[0]?.id).toBe("aws_ecs_ec2_container_inventory");
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_resource_inventory")).toBe(true);
});

test("factory helper catalog: RDS alarm prompts include alarm summary instead of unrelated exposure helpers", async () => {
  const context = await loadFactoryHelperContext({
    profileRoot: process.cwd(),
    provider: "aws",
    objectiveTitle: "RDS alarm closure",
    objectivePrompt: "Investigate the current RDS estate and alarm posture in the active AWS account. Inventory active RDS instances and clusters, correlate alarm state, and conclude whether any database or alarm condition currently needs attention.",
    taskTitle: "RDS alarm closure",
    taskPrompt: "Use the checked-in helpers first, then correlate database inventory and CloudWatch alarm state.",
    domain: "infrastructure",
  });

  expect(context?.selectedHelpers[0]?.id).toBe("aws_alarm_summary");
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_resource_inventory")).toBe(true);
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_alarm_summary")).toBe(true);
  expect(context?.selectedHelpers.some((helper) => helper.id === "aws_internet_exposure_inventory")).toBe(false);
});
