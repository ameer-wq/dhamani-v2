# Dhamani agent contract

- The Founder owns product decisions. Frozen specifications are implementation authority.
- Codex implements only frozen scope; no model invents product behavior.
- Never add a production mock, fail-open shortcut, or disable a test/gate to obtain green CI.
- Report unexpected contradictions and stop where a frozen requirement says to stop.
- Production code defaults to Codex in the normal cycle. Claude Code adversarial tests are
  evidence; production fixes return to Codex.
- Architecture flows from apps to approved packages. Packages never import apps, apps never
  import other apps, mobile never imports server/database packages, and production never imports
  `@dhamani/testkit`.
- Verify with: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm build`, `pnpm boundaries:check`, `pnpm secrets:check`, `pnpm db:validate`,
  `pnpm spec000:migration:verify`, `pnpm mobile:typecheck`, `pnpm mobile:doctor`,
  `pnpm mobile:export:ci`, `pnpm spec000:ci-definition:verify`,
  `pnpm spec000:evidence:verify`, `pnpm toolchain:verify`, and `pnpm ci:verify`.
- `dhamani_bootstrap._migration_probe` is intentional infrastructure proof. Do not reset or drop
  a database merely to silence future Prisma drift. Do not replace `migrate deploy` with
  `db push`. If future Prisma tooling reports drift, stop and follow the frozen migration policy.
