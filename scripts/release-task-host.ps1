param([Parameter(Mandatory = $true)][string]$NodePath, [Parameter(Mandatory = $true)][string]$Repository)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'The configured Node runtime is unavailable.' }
$logPath = Join-Path $PSScriptRoot 'runner.log'
[IO.File]::WriteAllText($logPath, 'Started ' + [DateTime]::UtcNow.ToString('o'))
$ErrorActionPreference = 'Continue'
$output = & $NodePath (Join-Path $Repository 'scripts\release-runner.cjs') --once --root $Repository 2>&1
$exitCode = $LASTEXITCODE
[IO.File]::WriteAllText($logPath, ($output | Out-String))
exit $exitCode
