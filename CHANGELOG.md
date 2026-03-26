# Changelog

All notable changes to this project should be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [0.1.0] - 2026-03-26

### Added
- Public CLI packaging for Node.js with `dist/cli.js` binary output.
- `receipt start` setup wizard for OpenAI key, GitHub auth, and AWS auth/profile/account selection.
- Local setup config persistence at `~/.receipt/config.json` with strict permissions.
- Packed artifact smoke test via `npm run pack:smoke`.
- Setup flow smoke tests for failure and success branches.

### Changed
- CLI packaging target renamed to `receipt-agent-cli`.
- `receipt start` now reruns setup checks and reuses saved selections by default.
- `receipt start --reset` now ignores saved selections and reconfigures from scratch.
