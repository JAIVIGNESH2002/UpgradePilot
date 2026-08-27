# UpgradePilot

UpgradePilot is an open-source TypeScript application for verified dependency-upgrade workflows.

The current milestone inspects public GitHub npm repositories, displays dependency inventory, and prepares deterministic baseline verification through the configured TrueForge sandbox boundary.

## Tech Stack

- Next.js with the App Router
- TypeScript in strict mode
- Tailwind CSS
- shadcn/ui conventions
- ESLint and Prettier
- Vitest for unit tests
- Playwright prepared for future E2E tests
- GitHub Actions CI
- Conventional Commits

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

Inspect any public GitHub npm repository by entering a URL such as:

```text
https://github.com/owner/repository
```

## Quality Checks

Run the same checks used by CI:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run e2e
```

Format files:

```bash
npm run format
```

Check formatting:

```bash
npm run format:check
```

## Environment

Copy `.env.example` to `.env.local` for local development.

`TRUEFORGE_BASE_URL` points UpgradePilot at an already-running TrueForge service. The expected local default is:

```text
TRUEFORGE_BASE_URL=http://localhost:8790
```

`GITHUB_TOKEN` is optional and server-side only. Public repository inspection works without it, but GitHub will apply unauthenticated rate limits.

## Milestone 1 Flow

1. Fetch public GitHub repository metadata.
2. Read root `package.json` and `package-lock.json` through GitHub's API.
3. Extract Node requirement, npm lockfile status, dependencies, devDependencies, current versions, and verification scripts.
4. Display the repository detail page with the dependency inventory.
5. Prepare baseline verification in deterministic application code: `npm ci`, then available `format:check`, `lint`, `typecheck`, `test`, and `build`.

## TrueForge Integration

UpgradePilot talks to TrueForge through `TRUEFORGE_BASE_URL`. The current adapter validates `/healthz`, `/api/v1/openapi.json`, and `/api/v1/settings/sandbox-providers`.

The confirmed TrueForge `0.2.0-rc.0` API exposes agent sessions and sandbox provider configuration, but does not expose a direct deterministic sandbox command execution endpoint. UpgradePilot therefore reports baseline verification as blocked rather than routing routine orchestration through an LLM conversation.

## Project Scope

This milestone does not include dependency upgrades, AI repair, GitHub authentication flows, PR creation, Qodo integration, vulnerability scanning, or latest-version recommendation logic.
