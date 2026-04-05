# `/help` Output Contract

The Factory composer recognizes `/help` and `/?` as the help command.

Expected response shape:
- The command is accepted without creating or mutating an objective.
- The user is returned to the workbench route for the current session.
- The command palette exposes the available slash commands below.

Command list:
- `/help` or `/?` - show slash command help.
- `/analyze` - open the run analysis for the selected objective.
- `/obj` - create a new objective from the prompt.
- `/new` - start a new thread from the prompt.
- `/react` - react to the selected objective.
- `/watch` - focus an objective by id.
- `/promote` - promote the selected objective.
- `/cancel` - cancel the selected objective.
- `/cleanup` - clean up the selected objective.
- `/archive` - archive the selected objective.
- `/abort-job` - abort the active job.
- `/steer` - steer the active job for the selected objective.
- `/follow-up` - send follow-up guidance to the active job for the selected objective.
