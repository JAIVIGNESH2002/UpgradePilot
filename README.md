# UpgradePilot

UpgradePilot is an open-source TypeScript project foundation for future dependency-upgrade workflows.

This repository currently contains only the production-ready project scaffold. Product UI and dependency-upgrade functionality are intentionally not implemented yet.

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

## Quality Checks

Run the same checks used by CI:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
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

Copy `.env.example` to `.env.local` for local development. No secrets or runtime configuration are required yet.

## Project Scope

This foundation does not include dependency-upgrade agents, pull request automation, package analysis, or product UI flows. Those should be added later through small, verified changes.
