$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\DHAMANI-V2-SPEC001-CLAUDE'

# Prevent a caller's ambient evidence URL from redirecting either proof away from the one
# application runtime target derived below.
Remove-Item Env:SPEC001_DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:SPEC001_RUNTIME_DATABASE_URL -ErrorAction SilentlyContinue
$env:DHAMANI_RUNTIME_MODE = 'test'
$env:DHAMANI_PRIVATE_SENTINEL = 'r4-a1-host-proof'
$env:SPEC001_RUNTIME_PASSWORD = 'runtime_test_only'
$env:SPEC001_PG_CONTAINER = 'dhamani-v2-spec001-claude-postgres-1'
$env:DOCKER_CONTEXT = 'desktop-linux'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = 'D:/DHAMANI-V2-SPEC001-CLAUDE'

$resultsDirectory = 'D:\DHAMANI-V2-SPEC001-CLAUDE\evidence\results'
$transcriptPath = Join-Path $resultsDirectory 'R4_A1_HOST_PROOF.log'
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null

function Wait-PostgresHealthy {
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $health = docker inspect --format '{{.State.Health.Status}}' $env:SPEC001_PG_CONTAINER
    if ($LASTEXITCODE -eq 0 -and $health.Trim() -eq 'healthy') { return }
    Start-Sleep -Seconds 1
  }
  throw "PostgreSQL container did not become healthy: $($env:SPEC001_PG_CONTAINER)"
}

$finalExitCode = 1
$cleanupFailed = $false
Start-Transcript -LiteralPath $transcriptPath -Force
try {
  docker version
  if ($LASTEXITCODE -ne 0) { throw "docker version failed with exit code $LASTEXITCODE" }

  docker start $env:SPEC001_PG_CONTAINER
  if ($LASTEXITCODE -ne 0) { throw "docker start failed with exit code $LASTEXITCODE" }
  Wait-PostgresHealthy

  # The host port is READ FROM the container that this proof stops, never hardcoded. A literal
  # port here is what previously pointed the application at an unrelated PostgreSQL while a
  # different container was stopped, which cannot demonstrate anything about the application.
  $publishedPort = (docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $env:SPEC001_PG_CONTAINER).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $publishedPort) { throw 'could not resolve the published host port' }
  $env:DATABASE_URL = "postgresql://dhamani_dev:dhamani_dev_only@127.0.0.1:$publishedPort/dhamani_dev"
  Write-Output "R4_A1_BACKING_CONTAINER=$($env:SPEC001_PG_CONTAINER) PUBLISHED_PORT=$publishedPort"
  Write-Output "DATABASE_URL=$($env:DATABASE_URL)"

  & '.\node_modules\.bin\vitest.cmd' run 'tooling/tests/spec001/db-protections.integration.test.ts' -t 'spec001_runtime_connection_role_is_nonowner_least_privilege' --reporter=verbose
  if ($LASTEXITCODE -ne 0) { throw "owner/runtime readiness proof failed with exit code $LASTEXITCODE" }

  # The probe itself proves the stopped container backs this exact DATABASE_URL before any outage.
  pnpm spec000:readiness:verify
  if ($LASTEXITCODE -ne 0) { throw "real readiness transition proof failed with exit code $LASTEXITCODE" }

  & '.\node_modules\.bin\vitest.cmd' run 'tooling/tests/spec001/restart.integration.test.ts' -t 'spec001_e33_real_restart_preserves_truth' --reporter=verbose
  if ($LASTEXITCODE -ne 0) { throw "strengthened E33 proof failed with exit code $LASTEXITCODE" }

  $finalExitCode = 0
  Write-Output 'R4_A1_HOST_PROOF=PASS'
} catch {
  Write-Output "R4_A1_HOST_PROOF=FAIL $($_.Exception.Message)"
} finally {
  try {
    docker start $env:SPEC001_PG_CONTAINER
    if ($LASTEXITCODE -ne 0) { throw "cleanup docker start failed with exit code $LASTEXITCODE" }
    Wait-PostgresHealthy
  } catch {
    $cleanupFailed = $true
    Write-Output "R4_A1_HOST_PROOF_CLEANUP=FAIL $($_.Exception.Message)"
  }
  Stop-Transcript
}

if ($cleanupFailed) { $finalExitCode = 1 }
exit $finalExitCode
