# Factory PR Publisher

Use this skill when you are dispatched as the `publisher` worker to publish an integrated Factory objective.

## Your Job

You have been dispatched to publish the final results of a Factory objective. The objective has already been completed, tested, and locally integrated. Your only job is to push these changes to the remote repository and open a Pull Request.

## Execution Steps

1. Read the objective history using the `receipt` CLI to understand what was built:
   - `receipt memory summarize factory/objectives/<objectiveId>`
   - `receipt inspect factory/objectives/<objectiveId>`
2. Check the current git status and inspect the available remotes:
   - `git remote -v`
   - Push the current branch to a GitHub-backed remote, preferring `origin` when present:
   - `git push -u origin HEAD`
   - If `origin` is not the GitHub remote, push to the remote that points at the GitHub repository instead.
3. Use the `gh` CLI to create a Pull Request:
   - Write a detailed PR description summarizing the objective, the tasks completed, and the test/validation results.
   - First check whether the current branch already has a PR with `gh pr view --json url,number,headRefName,baseRefName`.
   - If no PR exists yet, run `gh pr create --title "<Objective Title>" --body "<Detailed Markdown Body>"`
   - If `gh pr create` fails after a transient GitHub/network error, check `gh pr view --json url,number,headRefName,baseRefName` before assuming the PR was not created.
4. Once the PR is created, fetch the final metadata for the current branch:
   - `gh pr view --json url,number,headRefName,baseRefName`
5. Retry transient GitHub/network failures carefully:
   - Retry `git push`, `gh pr create`, or `gh pr view` up to 2 more times when the error looks transient, such as `Could not resolve host`, `error connecting to api.github.com`, timeouts, connection resets, or GitHub 5xx responses.
   - Use a short backoff between retries.
   - Do not retry permission, auth, validation, or duplicate-PR errors.
6. Return a strict JSON object as your final response:
   - `{"summary":"<short publish summary>","prUrl":"https://github.com/...","prNumber":123,"headRefName":"branch-name","baseRefName":"main"}`
   - Use `null` for `prNumber`, `headRefName`, or `baseRefName` only when GitHub does not return them.

## Rules

- Do NOT attempt to run builds or tests; the code has already been validated by the Factory integration pipeline.
- Do NOT make any code changes.
- Ensure the PR description is thorough and explains the "why" and "what" based on the receipts.
- Return publish metadata, not prose-only success text.
