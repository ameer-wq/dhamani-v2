$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\DHAMANI-V2-SPEC001-CLAUDE'

Remove-Item Env:SPEC001_DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:SPEC001_RUNTIME_DATABASE_URL -ErrorAction SilentlyContinue
$env:DHAMANI_RUNTIME_MODE = 'test'
$env:DHAMANI_PRIVATE_SENTINEL = 'r4-e33-host-proof'
$env:SPEC001_RUNTIME_PASSWORD = 'runtime_test_only'
$env:SPEC001_PG_CONTAINER = 'dhamani-v2-spec001-claude-postgres-1'
$env:DOCKER_CONTEXT = 'desktop-linux'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = 'D:/DHAMANI-V2-SPEC001-CLAUDE'

# Derived from the container this proof restarts, so the application cannot be pointed at a
# different PostgreSQL than the one being stopped.
$publishedPort = (docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $env:SPEC001_PG_CONTAINER).Trim()
if ($LASTEXITCODE -ne 0 -or -not $publishedPort) { throw 'could not resolve the published host port' }
$env:DATABASE_URL = "postgresql://dhamani_dev:dhamani_dev_only@127.0.0.1:$publishedPort/dhamani_dev"
Write-Output "R4_E33_BACKING_CONTAINER=$($env:SPEC001_PG_CONTAINER) PUBLISHED_PORT=$publishedPort"
Write-Output "DATABASE_URL=$($env:DATABASE_URL)"

& '.\node_modules\.bin\vitest.cmd' run 'tooling/tests/spec001/restart.integration.test.ts' -t 'spec001_e33_real_restart_preserves_truth' --reporter=verbose
exit $LASTEXITCODE
