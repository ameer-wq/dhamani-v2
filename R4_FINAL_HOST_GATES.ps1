$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\DHAMANI-V2-SPEC001-CLAUDE'

$env:DHAMANI_RUNTIME_MODE = 'test'
$env:DHAMANI_PRIVATE_SENTINEL = 'r4-final-host-gates'
$env:SPEC001_RUNTIME_PASSWORD = 'runtime_test_only'
$env:SPEC001_PG_CONTAINER = 'dhamani-v2-spec001-claude-postgres-1'
$env:DOCKER_CONTEXT = 'desktop-linux'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = 'D:/DHAMANI-V2-SPEC001-CLAUDE'
$env:R4_FINAL_DATABASE_NAME = 'dhamani_r4_final_' + (Get-Date -Format 'yyyyMMddHHmmss')

$resultsDirectory = 'D:\DHAMANI-V2-SPEC001-CLAUDE\evidence\results'
$transcriptPath = Join-Path $resultsDirectory 'R4_FINAL_HOST_GATES.log'
New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null

$finalExitCode = 1
Start-Transcript -LiteralPath $transcriptPath -Force
try {
  docker version
  if ($LASTEXITCODE -ne 0) { throw "docker version failed with exit code $LASTEXITCODE" }

  docker inspect --format '{{json .State.Health}}' $env:SPEC001_PG_CONTAINER
  if ($LASTEXITCODE -ne 0) { throw "docker inspect failed with exit code $LASTEXITCODE" }

  docker exec $env:SPEC001_PG_CONTAINER psql -U dhamani_dev -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $($env:R4_FINAL_DATABASE_NAME);"
  if ($LASTEXITCODE -ne 0) { throw "clean database creation failed with exit code $LASTEXITCODE" }

  # Read the published host port from the very container the clean database was just created in.
  # A hardcoded port previously created the base database in one container while the evidence
  # database and every test ran against a different, unrelated PostgreSQL.
  $publishedPort = (docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' $env:SPEC001_PG_CONTAINER).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $publishedPort) { throw 'could not resolve the published host port' }
  $env:DATABASE_URL = "postgresql://dhamani_dev:dhamani_dev_only@127.0.0.1:$publishedPort/$($env:R4_FINAL_DATABASE_NAME)"
  Write-Output "R4_BACKING_CONTAINER=$($env:SPEC001_PG_CONTAINER) PUBLISHED_PORT=$publishedPort"
  Write-Output "DATABASE_URL=$($env:DATABASE_URL)"

  pnpm ci:verify
  $aggregateExitCode = $LASTEXITCODE

  $reportPath = Join-Path $resultsDirectory 'vitest.json'
  if (-not (Test-Path -LiteralPath $reportPath)) { throw "Vitest JSON report was not created: $reportPath" }
  $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  [pscustomobject][ordered]@{
    numTotalTestSuites  = $report.numTotalTestSuites
    numPassedTestSuites = $report.numPassedTestSuites
    numFailedTestSuites = $report.numFailedTestSuites
    numTotalTests       = $report.numTotalTests
    numPassedTests      = $report.numPassedTests
    numFailedTests      = $report.numFailedTests
    numPendingTests     = $report.numPendingTests
    success             = $report.success
  } | Format-List
  $report.testResults | ForEach-Object {
    $_.assertionResults | Where-Object { $_.status -ne 'passed' } | ForEach-Object {
      Write-Output "NON_PASSING_TEST=$($_.status) $($_.fullName)"
    }
  }

  if ($aggregateExitCode -ne 0) { throw "pnpm ci:verify failed with exit code $aggregateExitCode" }
  if (-not $report.success -or $report.numFailedTests -ne 0 -or $report.numPendingTests -ne 0) {
    throw 'Vitest report is not fully green'
  }
  $finalExitCode = 0
  Write-Output 'R4_FINAL_HOST_GATES=PASS'
}
catch {
  Write-Output "R4_FINAL_HOST_GATES=FAIL $($_.Exception.Message)"
}
finally {
  Stop-Transcript
}

exit $finalExitCode
