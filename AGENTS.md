# Repository Guidelines

## Project Structure & Module Organization
- `agent/src` holds the runtime entrypoint and orchestration logic; local session state lives in `agent/data` (clear with `pnpm cleanstart` when needed).
- Modular plugins live in `packages/*`, each exporting `src/index.ts` and keeping package-level specs in `test/`.
- The Next.js dashboard is in `client/`, with deployment references in `docs/` and working examples in `examples/`.
- Cross-workspace integration and streaming cases are in `tests/`, while component-focused checks live in `agent/test` or package `test/` folders.
- Shared configuration appears in `biome.json`, `tsconfig.json`, `turbo.json`, and `pnpm-workspace.yaml`.

## Build, Test, and Development Commands
- `pnpm install` — bootstrap workspace dependencies (preinstall enforces pnpm).
- `pnpm dev` — run the combined developer workflow from `scripts/dev.sh`.
- `pnpm build` — execute the Turbo pipeline across workspaces.
- `pnpm --filter "@elizaos/agent" start --isRoot` — launch the agent locally.
- `pnpm lint | pnpm format | pnpm check` — run Biome linting, formatting, and type checks.
- `pnpm test`, `pnpm smokeTests`, `pnpm integrationTests`, `pnpm test:streaming` — unit, smoke, integration, and streaming suites.

## Coding Style & Naming Conventions
- TypeScript with 4-space indents, double quotes, semicolons, and no `var` (Biome defaults).
- Prefer functional patterns and explicit types; document any `any` usage.
- Workspaces, folders, and filenames use kebab-case (e.g., `packages/sse-adapter/`); exports use PascalCase or camelCase.

## Testing Guidelines
- Jest is used for server modules (`jest.config.json`); some areas use Vitest where noted.
- Name specs `*.test.ts` and colocate them with sources unless they belong in `tests/`.
- For reproducibility-sensitive runs, reset `agent/data/db.sqlite` via `pnpm cleanstart`.

## Commit & Pull Request Guidelines
- Use Conventional Commits with a subject ≤ 72 characters (e.g., `feat: add sse adapter`).
- Branch names follow `1234--short-description`.
- PRs should summarize scope, link issues, note config/secret changes, and include screenshots for UI work.
- Include evidence of `pnpm lint` and `pnpm test`, and mention any manual verification.

## Security & Configuration Tips
- Review `docs/notes/local-development.md` and `.env` templates before running agents.
- Use `scripts/clean.sh` when switching characters or datasets to avoid stale caches.
