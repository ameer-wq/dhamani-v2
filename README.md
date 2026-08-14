# Dhamani

SPEC-000 repository bootstrap only. No product behavior is implemented.

## Toolchain

Use Node 24.19.0 and pnpm 11.21.0. Run `pnpm install --frozen-lockfile`, then
`docker compose up -d postgres`, copy `.env.example` to an untracked `.env`, and run
`pnpm ci:verify`.

`EXPO_PUBLIC_*` and `NEXT_PUBLIC_*` values are public client configuration and must never
contain private server secrets. Private configuration is injected into the API environment.
Expo Development Builds are the intended native development architecture; Expo Go is not a
production assumption.
