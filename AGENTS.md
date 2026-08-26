# AGENTS.md

# UpgradePilot

## Product Overview

UpgradePilot is an open-source autonomous software maintenance agent.

Its initial focus is dependency upgrades for Node.js repositories.

Traditional dependency-update tools can identify outdated dependencies, bump
versions, and open pull requests. UpgradePilot goes further: it attempts to
complete and verify the upgrade before asking a developer to review it.

The core workflow is:

1. Analyze the target repository and requested dependency upgrade.
2. Create an isolated sandbox.
3. Establish a passing baseline where possible.
4. Apply the dependency upgrade.
5. Run the repository's actual verification commands.
6. If verification fails, investigate whether the upgrade caused the failure.
7. Attempt safe compatibility fixes when appropriate.
8. Re-run verification after every repair.
9. Produce evidence explaining what changed and how it was verified.
10. Create a pull request only when the configured verification requirements
    are satisfied.
11. Leave the final review and merge decision to a human.

## Core Product Principle

Generating code or opening a pull request is not success.

Success means producing a verified, reviewable maintenance change backed by
actual execution evidence.

UpgradePilot must never claim an upgrade is successful based solely on model
reasoning. Verification must come from real execution.

If UpgradePilot cannot safely complete an upgrade, it must report the run as
blocked rather than forcing a successful result.

Prefer a truthful failure over a misleading success.

## Current MVP Scope

The MVP supports:

- GitHub repositories
- Node.js / npm projects
- dependency discovery
- individual dependency upgrades
- isolated sandbox execution
- baseline verification
- test, build, lint, and typecheck verification where available
- AI-assisted failure diagnosis
- safe compatibility repair attempts
- verification evidence
- pull request creation
- human-controlled merging

Do not expand into additional ecosystems or maintenance categories unless
explicitly requested.

## Architecture Principle

UpgradePilot is the product.

TrueForge is the agent harness and execution layer used underneath the product.

Keep UpgradePilot's core domain logic separate from TrueForge-specific
implementation details where practical.

The model is a reasoning component, not the source of truth.

Prefer deterministic tools for deterministic work:

- dependency discovery
- package parsing
- command execution
- Git operations
- test execution
- build execution
- diff generation
- verification status

Use the model when reasoning is actually required, such as:

- diagnosing failures
- understanding compatibility problems
- identifying affected code
- proposing safe migrations
- repairing upgrade-related failures

Do not send unnecessary repository context to the model.

## Safety and Verification

The agent must:

- perform untrusted repository work inside an isolated sandbox
- preserve evidence from verification commands
- clearly report application-code changes
- re-run relevant verification after modifying code
- stop when a safe result cannot be established
- require human control over the final merge

The agent must never:

- disable, delete, skip, or weaken tests to obtain a passing result
- weaken assertions to hide regressions
- suppress compiler, lint, or runtime errors merely to pass verification
- modify CI configuration solely to make a failing upgrade appear successful
- fabricate command output, test results, verification evidence, or success
- expose credentials or secrets
- force-push unless explicitly required and approved
- merge its own pull request
- silently broaden the scope of an upgrade

A green test suite is evidence, not absolute proof of correctness. Clearly
distinguish executed verification from model confidence.

## Pull Requests and Git

Use Conventional Commits for repository history.

Examples:

- `feat: add dependency scanner`
- `fix: handle failed sandbox execution`
- `test: cover blocked upgrade workflow`
- `refactor: isolate github client`
- `docs: document verification model`
- `chore: update development tooling`

Prefer small, atomic commits and focused pull requests.

Before considering work complete:

1. inspect the diff
2. run lint
3. run typecheck
4. run relevant tests
5. run build when applicable
6. confirm no debug code or accidental secrets remain

Never combine unrelated work merely to reduce the number of commits.

## Qodo and Independent Review

Qodo is an independent code-review and quality layer.

Use Qodo on project pull requests where applicable and treat its findings as
engineering feedback rather than a checkbox.

For each meaningful Qodo finding:

1. understand the finding
2. determine whether it is valid in context
3. fix valid issues
4. re-run affected verification
5. document or justify intentionally rejected findings when appropriate

Do not blindly apply automated suggestions.

Do not modify code merely to silence a review tool when the change would reduce
correctness, clarity, security, or maintainability.

Qodo must not become a hard dependency of UpgradePilot's core upgrade engine.

UpgradePilot must remain capable of performing and verifying upgrades without
Qodo.

Where Qodo is available, it may act as an additional independent review layer
for pull requests produced by UpgradePilot.

The conceptual trust model is:

UpgradePilot -> executes and verifies the maintenance change
Qodo -> independently reviews the resulting code change
CI -> independently executes repository checks after the PR is pushed
Human -> makes the final merge decision

Do not collapse these independent responsibilities into one system.

## UI and Product Experience

The interface should feel like a polished developer tool, not a generic AI
chat application.

The desired visual direction is:

- modern
- clean
- confident
- minimal
- technically credible
- high information density without clutter
- strong typography
- clear visual hierarchy
- restrained use of color
- thoughtful whitespace
- subtle, purposeful motion

Avoid:

- generic AI-chat layouts
- excessive gradients
- excessive glassmorphism
- unnecessary cards inside cards
- decorative animations
- oversized marketing elements inside product workflows
- excessive badges
- visual clutter
- exposing raw agent reasoning as the primary UX

The UI should make complex agent activity easy to understand.

The most important product experience is the Upgrade Run.

Users should be able to quickly understand:

- what is being upgraded
- current and target versions
- what the agent is doing
- what has already completed
- what failed
- what the agent changed
- what verification was actually executed
- whether the result is verified, blocked, or still running
- what requires human attention

Prefer a clear execution timeline over a chat transcript.

Example:

Repository analyzed
|
Baseline verified
|
Sandbox created
|
Dependency upgraded
|
Verification failed
|
Compatibility issue identified
|
2 files repaired
|
Verification rerun
|
Verified
|
Pull request ready

Status must never rely on color alone.

Support accessible keyboard interaction, visible focus states, appropriate
semantic HTML, responsive layouts, loading states, empty states, error states,
and reduced-motion preferences.

Do not sacrifice usability for visual novelty.

## Product Transparency

Every completed upgrade run should make its evidence understandable.

Where available, expose:

- dependency version change
- baseline verification result
- post-upgrade verification result
- commands executed
- files modified
- relevant test counts
- build result
- typecheck result
- lint result
- repair attempts
- final status
- resulting pull request

Distinguish clearly between:

- facts observed from execution
- changes made by the agent
- conclusions inferred by the model

Never present model inference as executed evidence.

## Engineering Philosophy

Prefer simple, explicit implementations over clever abstractions.

Do not introduce infrastructure, dependencies, services, or abstraction layers
until the current product requires them.

Avoid speculative architecture for future features.

Business logic should not live inside React components.

Keep external integrations behind clear boundaries.

Errors should be actionable rather than swallowed.

Every meaningful feature should have appropriate tests.

Do not consider a feature complete because it works on the happy path.

Consider:

- loading
- empty
- success
- partial failure
- complete failure
- retry
- timeout
- malformed external responses
- authorization failures

when applicable.

## Future Direction

UpgradePilot may eventually expand from dependency upgrades into autonomous
software maintenance, including:

- security remediation
- runtime upgrades
- framework migrations
- deprecated API migrations
- Python, Go, and other ecosystems
- infrastructure dependency upgrades

The current architecture should not unnecessarily prevent these directions.

However, do not implement them prematurely.

Build the Node.js dependency-upgrade workflow exceptionally well first.

These rules apply to all AI and automation agents working in this repository.

## Engineering Rules

- Prioritize safety, verification, transparency, and developer experience.
- Never fake execution or success states.
- Never weaken or delete tests to obtain a passing result.
- Keep business logic out of React components.
- Avoid unnecessary abstractions and dependencies.
- Every feature must pass lint, typecheck, tests, and build.
- Use small atomic changes.
- Use Conventional Commits.
- Destructive or external actions require explicit approval.
- Dependency-upgrade agents must never merge their own pull requests.
- Secrets must never appear in logs.
- UI should be modern, minimal, accessible, and developer-tool oriented rather than chat-like.

## Expected Workflow

1. Understand the change and inspect relevant code before editing.
2. Make the smallest practical change.
3. Add or update tests for behavior changes.
4. Run the required quality checks.
5. Report what changed, what was verified, and any remaining risk.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
