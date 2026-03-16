# Memory Scopes

Factory workers already get a layered memory interface. Use the narrowest scope that can answer the question.

## Scope Meanings

- `factory/agents/<workerType>`
  - Worker-specific guidance and recurring patterns for this worker type.
- `factory/repo/shared`
  - Repo-level durable facts that can apply across objectives.
- `factory/objectives/<objectiveId>`
  - Objective-wide memory and durable summaries.
- `factory/objectives/<objectiveId>/tasks/<taskId>`
  - Facts specific to the current task prompt and prior task passes.
- `factory/objectives/<objectiveId>/candidates/<candidateId>`
  - Candidate-specific facts, especially around review and iteration.
- `factory/objectives/<objectiveId>/integration`
  - Integration and promotion facts for the current objective.

## Preferred Usage

- For current-task understanding, start with `context` and `objective` from the generated memory script.
- For repo conventions or repeated guardrails, query `factory/repo/shared`.
- For retry and review decisions, query the task and candidate scopes.
- For promotion or validation questions, query the integration scope.

## Scope Selection Rules

- Prefer the narrowest scope that answers the question.
- Do not use repo-shared memory to override current-objective evidence.
- Do not assume cross-objective receipt discovery is available in phase 1; broader context is memory-first.
- If the memory summary is too vague, inspect the current objective receipts instead of inventing detail.
