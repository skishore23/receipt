import type { AgentEvent } from "../../src/modules/agent";
import type { FactoryEvent } from "../../src/modules/factory";

export type HistoricalFactoryChatAction = {
  readonly iteration: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
};

const objectivePrompt = `Goal: determine how many EC2 instances are currently running in the mounted AWS account and what their schedules are.

Do this via a deterministic shell script under .receipt/factory/ using AWS CLI. Fail fast: set -euo pipefail, AWS_PAGER="", and capture aws sts get-caller-identity first.

Tasks:
1) Count and list all EC2 instances with state=running across all regions. Output: total running count, per-region counts, and a table with: Region, InstanceId, Name tag, InstanceType, LaunchTime, VpcId/SubnetId, PrivateIp, PublicIp, AutoScalingGroup name (if any), and any schedule-related tags (keys containing schedule, scheduler, start, stop, uptime, downtime) and their values.
2) Determine "schedules" from evidence sources (best-effort, but explicit):
   - AWS Instance Scheduler (solutions) tags (e.g., Schedule, Scheduled, ScheduleName, etc.) on instances.
   - Auto Scaling Group scheduled actions affecting the instance's ASG (describe-auto-scaling-groups + describe-scheduled-actions)
   - EventBridge rules that target SSM Automation / Lambda that look like start/stop for instances (list rules with patterns on EC2 StartInstances/StopInstances or targets referencing instance ids).
   - SSM Maintenance Windows (if used) that start/stop instances (list maintenance windows and targets).
Provide a plain-language summary with what is confidently known vs unknown. If any AWS CLI call fails, stop and report the exact error. Include the script path and save machine-readable JSON alongside human output under .receipt/factory/.`;

const task01Prompt = `Write a deterministic bash script at .receipt/factory/ec2_running_inventory_and_schedules.sh that:

- Starts with: set -euo pipefail; export AWS_PAGER=""; export AWS_PROFILE=default (unless already set).
- Captures identity first and fails fast on any AWS CLI error:
  - aws sts get-caller-identity --output json > .receipt/factory/sts_get_caller_identity.json
- Uses ONLY the provided queryable regions list (17): ap-south-1 ca-central-1 eu-central-1 us-west-1 us-west-2 eu-north-1 eu-west-3 eu-west-2 eu-west-1 ap-northeast-3 ap-northeast-2 ap-northeast-1 sa-east-1 ap-southeast-1 ap-southeast-2 us-east-1 us-east-2.

For each region:
1) EC2 running inventory:
- Call describe-instances filtered to state=running.
- For each running instance, extract and store (and include region on every record):
  Region, InstanceId, Name tag, InstanceType, LaunchTime, VpcId, SubnetId, PrivateIpAddress, PublicIpAddress (if any).
- Detect AutoScalingGroup name from tags (key "aws:autoscaling:groupName"); if absent, set null.
- Extract schedule-related tags whose keys match (case-insensitive) any of: schedule, scheduler, start, stop, uptime, downtime. Include key/value pairs on the instance record.
- Emit machine-readable JSON:
  - .receipt/factory/ec2_running_instances.json (array of instance objects)
  - .receipt/factory/ec2_running_instances_by_region.json (object region->count)
  - .receipt/factory/ec2_running_instances_total.json (object with total)
- Emit a human-readable table TSV/CSV and a Markdown summary:
  - .receipt/factory/ec2_running_instances_table.tsv with columns: Region,InstanceId,Name,InstanceType,LaunchTime,VpcId,SubnetId,PrivateIp,PublicIp,AutoScalingGroup,ScheduleTags

2) ASG schedule evidence:
- For any discovered ASG names in the region, query:
  - aws autoscaling describe-auto-scaling-groups
  - aws autoscaling describe-scheduled-actions --auto-scaling-group-name ...
- Save JSON per region and a merged file:
  - .receipt/factory/asg_scheduled_actions_<region>.json
  - .receipt/factory/asg_scheduled_actions_all.json

3) EventBridge schedule evidence (best-effort but explicit):
- List rules in the region (eventbridge list-rules) and then for each rule fetch:
  - eventbridge describe-rule
  - eventbridge list-targets-by-rule
- Heuristically flag rules likely related to EC2 start/stop by:
  - rule EventPattern containing "StartInstances" or "StopInstances" or "ec2.amazonaws.com" with those eventNames
  - OR targets whose Arn service is ssm (Automation), lambda, or states AND inputs mention StartInstances/StopInstances or instance IDs.
- Save raw JSON plus a filtered "suspected" list:
  - .receipt/factory/eventbridge_rules_<region>.json
  - .receipt/factory/eventbridge_suspected_startstop_<region>.json
  - .receipt/factory/eventbridge_suspected_startstop_all.json

4) SSM Maintenance Windows evidence:
- Query:
  - aws ssm describe-maintenance-windows
  - For each window: describe-maintenance-window-targets, describe-maintenance-window-tasks
- Save:
  - .receipt/factory/ssm_maintenance_windows_<region>.json
  - .receipt/factory/ssm_maintenance_windows_all.json

Finally, produce a plain-language summary report at .receipt/factory/summary.md that:
- States total running instances and per-region counts.
- Lists any instances with schedule-related tags and what those tags imply (explicitly label as "confident" only when tags clearly map to a known scheduler format; otherwise "tag present but semantics unknown").
- Correlates instances in ASGs with any ASG scheduled actions (include action names, recurrence, desired capacity changes; note that this affects fleet size, not per-instance lifecycle).
- Summarizes suspected EventBridge rules and whether they directly target instance IDs or are generic.
- Summarizes any Maintenance Windows that target instances/instance tags.
- Clearly separates: confidently known vs unknown / not found.

Run the script and include in the task output:
- The exact script path
- Any AWS CLI errors (fail fast, paste exact error)
- Key results from the generated summary.

Implementation notes:
- Use jq for JSON shaping if available; if jq is not available, rely on AWS CLI --query and careful JSON output.
- Keep the script deterministic and idempotent; write outputs to .receipt/factory/ and overwrite existing files.
- Avoid querying non-opted-in regions; do not call ec2 describe-regions except optionally for verification.`;

const task02Prompt = `Read the generated artifacts under .receipt/factory/ from task_01 (EC2 running instances JSON/table, ASG scheduled actions, suspected EventBridge rules, SSM maintenance windows, and summary.md draft).

Produce a final reconciled synthesis that:
- Enumerates running instances and their most likely schedule source(s) in priority order: instance scheduler tags > explicit EventBridge/SSM targeting > ASG scheduled actions > unknown.
- Calls out mismatches/ambiguities (e.g., schedule tag present but no scheduler infrastructure found; EventBridge rule exists but no instance targets).
- Provides an at-a-glance section: total running, regions, number with schedule tags, number in ASGs with scheduled actions, number with direct start/stop automation evidence, number unknown.
- Lists the top candidate schedule mechanisms found in this account and where to look next if unknown.

Return the narrative plus any key tables (brief) and reference the exact artifact filenames.`;

const followUpCreatePrompt = `Using AWS CLI in the mounted account, determine how many EC2 instances are currently in state=running across all regions, and identify their schedules. "Schedules" may be expressed as: (1) AWS Instance Scheduler (tags like Schedule/InstanceScheduler), (2) EventBridge/CloudWatch rules targeting SSM Automation/Lambda that start/stop instances, (3) Auto Scaling Group scheduled actions, or (4) Instance tags indicating a schedule (e.g., uptime, start/stop).

Produce: total running count, per-region breakdown, list of running instances with InstanceId, Name tag, region, and any schedule-related tags. Also list any ASG scheduled actions or Instance Scheduler resources found, and any EventBridge rules that reference EC2 start/stop or SSM documents for start/stop.

Implementation guidance: write a deterministic bash script under .receipt/factory/ that runs: aws sts get-caller-identity; enumerate regions; for each region query running instances with describe-instances; extract tags; then query autoscaling describe-scheduled-actions; query resourcegroupstaggingapi for Instance Scheduler tags; and list EventBridge rules with patterns/targets referencing EC2 StartInstances/StopInstances or SSM automation. Fail fast on any AWS CLI error and report exact error. Save machine-readable outputs (json) alongside a human summary.`;

const fallbackDispatchInstructions = `Use AWS CLI only. Fail fast (set -euo pipefail). First run aws sts get-caller-identity and record account/arn. Then: 1) Count EC2 instances in state=running across all regions (iterate regions from aws ec2 describe-regions). Output total count and per-region list with InstanceId, Name tag, LaunchTime, InstanceType. 2) Determine schedules: a) Look for AWS Instance Scheduler solution tags (e.g., Schedule, Scheduler, InstanceScheduler) on instances; b) Look for EventBridge rules that target EC2 StartInstances/StopInstances or SSM Automation that starts/stops instances; c) If using AWS Systems Manager State Manager/Automation, check associations/documents relevant to start/stop. Emit a clear mapping: instance -> detected schedule source(s) with rule/cron expression or tag value. If no schedule detected, say so. Save machine-readable JSON and a human-readable summary. Stop and report exact AWS CLI error on failure.`;

export const historicalInfrastructureObjectiveId = "objective_mn2jgg1g_9h9nph";
export const historicalInfrastructureStartupObjectiveId = "objective_mn2jbur7_qdifs2";
export const historicalInfrastructureChatStream = "agents/factory/1d4c5671337a/infrastructure/sessions/chat_mn2jbmv6_podcbp";

export const historicalInfrastructureObjectiveReceipts: ReadonlyArray<FactoryEvent> = [
  {
    type: "objective.created",
    objectiveId: historicalInfrastructureObjectiveId,
    title: "Inventory running EC2 instances and infer schedules",
    prompt: objectivePrompt,
    channel: "results",
    baseHash: "74e898c16d003b25993b0465d6def5aa5faef334",
    objectiveMode: "investigation",
    severity: 2,
    checks: ["bun run build"],
    checksSource: "default",
    profile: {
      rootProfileId: "infrastructure",
      rootProfileLabel: "Infrastructure",
      resolvedProfileHash: "9f896da2c932670ddb51c3eb807720684eb93fbe2c9fd4e29e68a2fc6c068156",
      promptHash: "9fabec8f26f1cc53df81ebfef3e39ea12f1938f5a5cbcc587ddd9cd98e24901f",
      promptPath: "profiles/infrastructure/PROFILE.md",
      selectedSkills: [
        "skills/factory-run-orchestrator/SKILL.md",
        "skills/factory-infrastructure-aws/SKILL.md",
      ],
      objectivePolicy: {
        allowedWorkerTypes: ["codex", "infra", "agent"],
        defaultWorkerType: "codex",
        defaultTaskExecutionMode: "isolated",
        defaultValidationMode: "repo_profile",
        defaultObjectiveMode: "investigation",
        defaultSeverity: 2,
        maxParallelChildren: 4,
        allowObjectiveCreation: true,
      },
    },
    policy: {
      concurrency: {
        maxActiveTasks: 4,
      },
      budgets: {
        maxTaskRuns: 50,
        maxCandidatePassesPerTask: 4,
        maxObjectiveMinutes: 1440,
      },
      throttles: {
        maxDispatchesPerReact: 4,
      },
      promotion: {
        autoPromote: false,
      },
    },
    createdAt: 1774231216248,
  },
  {
    type: "task.added",
    objectiveId: historicalInfrastructureObjectiveId,
    task: {
      nodeId: "task_01",
      taskId: "task_01",
      taskKind: "planned",
      title: "Create and run deterministic AWS CLI script to inventory running EC2 + schedule evidence and emit JSON + human summary",
      prompt: task01Prompt,
      workerType: "codex",
      baseCommit: "74e898c16d003b25993b0465d6def5aa5faef334",
      dependsOn: [],
      status: "pending",
      skillBundlePaths: [],
      contextRefs: [
        {
          kind: "state",
          ref: "factory/objectives/objective_mn2jgg1g_9h9nph:objective",
          label: "objective",
        },
        {
          kind: "commit",
          ref: "74e898c16d003b25993b0465d6def5aa5faef334",
          label: "base commit",
        },
      ],
      artifactRefs: {},
      createdAt: 1774231236685,
    },
    createdAt: 1774231236685,
  },
  {
    type: "task.added",
    objectiveId: historicalInfrastructureObjectiveId,
    task: {
      nodeId: "task_02",
      taskId: "task_02",
      taskKind: "planned",
      title: "Synthesize inventory + multi-signal schedule evidence into a concise 'what runs when' narrative",
      prompt: task02Prompt,
      workerType: "codex",
      baseCommit: "74e898c16d003b25993b0465d6def5aa5faef334",
      dependsOn: ["task_01"],
      status: "pending",
      skillBundlePaths: [],
      contextRefs: [
        {
          kind: "state",
          ref: "factory/objectives/objective_mn2jgg1g_9h9nph:objective",
          label: "objective",
        },
        {
          kind: "commit",
          ref: "74e898c16d003b25993b0465d6def5aa5faef334",
          label: "base commit",
        },
      ],
      artifactRefs: {},
      createdAt: 1774231236686,
    },
    createdAt: 1774231236686,
  },
  {
    type: "task.ready",
    objectiveId: historicalInfrastructureObjectiveId,
    taskId: "task_01",
    readyAt: 1774231236860,
  },
  {
    type: "candidate.created",
    objectiveId: historicalInfrastructureObjectiveId,
    createdAt: 1774231237032,
    candidate: {
      candidateId: "task_01_candidate_01",
      taskId: "task_01",
      status: "planned",
      baseCommit: "74e898c16d003b25993b0465d6def5aa5faef334",
      checkResults: [],
      artifactRefs: {},
      createdAt: 1774231237032,
      updatedAt: 1774231237032,
    },
  },
  {
    type: "task.dispatched",
    objectiveId: historicalInfrastructureObjectiveId,
    taskId: "task_01",
    candidateId: "task_01_candidate_01",
    jobId: "job_factory_objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01",
    workspaceId: "objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01",
    workspacePath: "/Users/kishore/receipt/.receipt/data/hub/worktrees/objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01",
    skillBundlePaths: [
      "/Users/kishore/receipt/.receipt/data/hub/worktrees/objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01/.receipt/factory/task_01.skill-bundle.json",
    ],
    contextRefs: [
      {
        kind: "state",
        ref: "factory/objectives/objective_mn2jgg1g_9h9nph:objective",
        label: "objective",
      },
      {
        kind: "commit",
        ref: "74e898c16d003b25993b0465d6def5aa5faef334",
        label: "base commit",
      },
    ],
    startedAt: 1774231237045,
  },
  {
    type: "objective.operator.noted",
    objectiveId: historicalInfrastructureObjectiveId,
    message: followUpCreatePrompt,
    notedAt: 1774231417746,
  },
  {
    type: "objective.canceled",
    objectiveId: historicalInfrastructureObjectiveId,
    canceledAt: 1774231672632,
    reason: "canceled from UI",
  },
  {
    type: "objective.slot.released",
    objectiveId: historicalInfrastructureObjectiveId,
    releasedAt: 1774231672940,
    reason: "slot released after objective entered canceled",
  },
  {
    type: "task.blocked",
    objectiveId: historicalInfrastructureObjectiveId,
    taskId: "task_01",
    reason: "Deterministic script: /Users/kishore/receipt/.receipt/data/hub/worktrees/objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01/.receipt/factory/ec2_running_inventory_and_schedules.sh. Outputs were written under /Users/kishore/receipt/.receipt/data/hub/worktrees/objective_mn2jgg1g_9h9nph_task_01_task_01_candidate_01/.receipt/factory/, including sts_get_caller_identity.json, ec2_running_instances*.json, asg_scheduled_actions_all.json, eventbridge_suspected_startstop_all.json, ssm_maintenance_windows_all.json, and summary.md. The blocking issue is IAM: the script captured AccessDeniedException for events:ListRules and ssm:DescribeMaintenanceWindows in every queried region, so schedule inference is limited to tags and ASG evidence only.",
    blockedAt: 1774231718407,
  },
];

export const historicalInfrastructureLoop = {
  runId: "run_mn2jg4gs_wsogft",
  chatId: "chat_mn2jbmv6_podcbp",
  problem: "how many ec2 instances do i have running and what are its schedules",
  startupObjectiveId: historicalInfrastructureStartupObjectiveId,
  dispatchedObjectiveId: historicalInfrastructureObjectiveId,
  actions: [
    {
      iteration: 1,
      name: "factory.dispatch",
      input: {
        action: "create",
        title: "Inventory running EC2 instances and infer schedules",
        objectiveMode: "investigation",
        severity: 2,
        prompt: objectivePrompt,
      },
    },
    { iteration: 2, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 3, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 4, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 5, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 6, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 7, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 8, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 9, name: "factory.output", input: { objectiveId: historicalInfrastructureObjectiveId } },
    { iteration: 10, name: "factory.output", input: { objectiveId: historicalInfrastructureObjectiveId } },
    { iteration: 11, name: "factory.output", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    {
      iteration: 12,
      name: "factory.dispatch",
      input: {
        action: "create",
        title: "Inventory running EC2 instances and schedules",
        objectiveMode: "investigation",
        severity: 2,
        prompt: followUpCreatePrompt,
      },
    },
    { iteration: 13, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 14, name: "jobs.list", input: { limit: 20, includeCompleted: true } },
    { iteration: 15, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 16, name: "factory.receipts", input: { objectiveId: historicalInfrastructureObjectiveId, limit: 20 } },
    { iteration: 17, name: "factory.status", input: { objectiveId: historicalInfrastructureStartupObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 18, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 120000 } },
    { iteration: 19, name: "factory.status", input: { objectiveId: historicalInfrastructureObjectiveId, waitForChangeMs: 8000 } },
    {
      iteration: 20,
      name: "factory.dispatch",
      input: {
        title: "EC2 running instances and schedules",
        objectiveMode: "investigation",
        severity: 2,
        worker: "codex",
        instructions: fallbackDispatchInstructions,
      },
    },
  ] satisfies ReadonlyArray<HistoricalFactoryChatAction>,
} as const;

export const historicalInfrastructureChatReceipts: ReadonlyArray<AgentEvent> = [
  {
    type: "problem.set",
    runId: historicalInfrastructureLoop.runId,
    problem: historicalInfrastructureLoop.problem,
    agentId: "orchestrator",
  },
  {
    type: "run.configured",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    workflow: {
      id: "factory-chat-v1",
      version: "1.0.0",
    },
    config: {
      maxIterations: 20,
      maxToolOutputChars: 6000,
      memoryScope: `repos/1d4c5671337a/profiles/infrastructure/objectives/${historicalInfrastructureStartupObjectiveId}`,
      workspace: ".",
      extra: {
        repoRoot: "/Users/kishore/receipt",
        profileRoot: "/Users/kishore/receipt",
        repoKey: "1d4c5671337a",
        repoMemoryScope: "repos/1d4c5671337a",
        profileMemoryScope: `repos/1d4c5671337a/profiles/infrastructure/objectives/${historicalInfrastructureStartupObjectiveId}`,
        profileId: "infrastructure",
        objectiveId: historicalInfrastructureStartupObjectiveId,
        stream: historicalInfrastructureChatStream,
      },
    },
    model: "gpt-5.2",
    promptHash: "9fabec8f26f1cc53df81ebfef3e39ea12f1938f5a5cbcc587ddd9cd98e24901f",
    promptPath: "profiles/infrastructure/PROFILE.md",
  },
  {
    type: "thread.bound",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    objectiveId: historicalInfrastructureStartupObjectiveId,
    chatId: historicalInfrastructureLoop.chatId,
    reason: "startup",
  },
  {
    type: "thread.bound",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    objectiveId: historicalInfrastructureObjectiveId,
    chatId: historicalInfrastructureLoop.chatId,
    reason: "dispatch_create",
    created: true,
  },
  {
    type: "thread.bound",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    objectiveId: historicalInfrastructureObjectiveId,
    chatId: historicalInfrastructureLoop.chatId,
    reason: "dispatch_reuse",
    created: false,
  },
  {
    type: "thread.bound",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    objectiveId: historicalInfrastructureStartupObjectiveId,
    chatId: historicalInfrastructureLoop.chatId,
    reason: "dispatch_update",
    created: false,
  },
  {
    type: "run.continued",
    runId: historicalInfrastructureLoop.runId,
    agentId: "orchestrator",
    nextRunId: "run_1774231538034_x0584p",
    nextJobId: "job_mn2jncdv_7cb7fc",
    profileId: "infrastructure",
    objectiveId: historicalInfrastructureStartupObjectiveId,
    previousMaxIterations: 20,
    nextMaxIterations: 24,
    continuationDepth: 1,
    summary: "Reached the current 20-step slice. Continuing automatically in this project chat as run_1774231538034_x0584p with a 24-step budget.",
  },
  {
    type: "run.status",
    runId: historicalInfrastructureLoop.runId,
    status: "completed",
    agentId: "orchestrator",
    note: "continued automatically as run_1774231538034_x0584p",
  },
];
