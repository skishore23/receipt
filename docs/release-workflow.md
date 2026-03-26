# Release Workflow

This document defines the Phase 9 release process for publishing `receipt-agent-cli`.

## Release Requirements

Before publishing:

1. `package.json` has the intended semantic version.
2. `CHANGELOG.md` contains a matching `## [x.y.z]` entry.
3. Release gate passes:
   - CLI build
   - smoke tests
   - packed artifact install smoke test

Use:

```bash
npm run verify:release
```

## Version Bump Discipline

Use semantic versioning:

- Patch (`x.y.Z`): bug fixes and reliability updates
- Minor (`x.Y.z`): backwards-compatible features
- Major (`X.y.z`): breaking changes

Update both:

1. `package.json` version
2. `CHANGELOG.md` section for the same version

## CI Gate

PR and push checks run in `.github/workflows/ci.yml`:

1. install dependencies (`bun install`)
2. `npm run build:cli`
3. `bun run test:smoke`
4. `npm run pack:smoke`
5. `node scripts/check-changelog.mjs`

## Publish

Use `.github/workflows/publish.yml` with manual dispatch from `main`.

Required secret:

- `NPM_TOKEN` (token with publish permission for `receipt-agent-cli`)

Publish command used by workflow:

```bash
npm publish --access public --provenance
```

## Optional Future Work

- Add a curl installer script after npm publishing is stable.
