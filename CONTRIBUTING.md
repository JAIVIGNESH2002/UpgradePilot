# Contributing

Thanks for helping improve UpgradePilot.

## Development Workflow

1. Create a focused branch for your change.
2. Keep changes small and atomic.
3. Add or update tests when behavior changes.
4. Run the full quality gate before opening a pull request:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Commit Messages

Use Conventional Commits:

```text
feat: add package manifest parser
fix: handle empty workspace names
docs: clarify local setup
test: cover dependency grouping
chore: update tooling
```

## Pull Requests

- Explain what changed and why.
- Include verification steps and any known limitations.
- Do not claim checks passed unless they were actually run.
- Do not weaken or delete tests to obtain a passing result.
- Keep secrets out of code, logs, screenshots, and issue comments.

## External and Destructive Actions

Any action that changes external systems, deletes data, rewrites history, publishes packages, opens pull requests, merges pull requests, or modifies production settings requires explicit approval.
