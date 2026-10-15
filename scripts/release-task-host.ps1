param([Parameter(Mandatory = $true)][string]$NodePath, [Parameter(Mandatory = $true)][string]$Repository)
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'The configured Node runtime is unavailable.' }
& $NodePath (Join-Path $Repository 'scripts\release-runner.cjs') --once --root $Repository
exit $LASTEXITCODE
