# UpgradePilot npm baseline verification

Use this workflow only for UpgradePilot Milestone 1 baseline verification of a
public GitHub npm repository.

The agent must invoke the UpgradePilot-supplied deterministic script in an
isolated TrueForge sandbox and return the script's structured result. The agent
must not decide the routine command sequence itself.

Required behavior:

- Clone the supplied public repository exactly once.
- Inspect only root `package.json` and `package-lock.json` metadata.
- Run `npm ci` exactly once.
- Run only available scripts from this ordered set: `format:check`, `lint`,
  `typecheck`, `test`, `build`.
- Never modify repository files.
- Never retry failed commands with workarounds.
- Never expose or request credentials.
- Return the marker-delimited JSON payload emitted by the workflow script.

The running TrueForge API currently accepts configured skills only from HTTPS
git manifests. Until this repository is published as a configured skill source,
UpgradePilot sends this constrained workflow as an inline sandbox-enabled
session turn.
