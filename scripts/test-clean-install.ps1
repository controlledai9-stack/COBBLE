param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$ExpectedVersion,
  [string]$OutputDirectory = (Join-Path $env:TEMP ('CobbleCleanCheck-' + [guid]::NewGuid().ToString('N')))
)
# Run only inside a disposable clean Windows VM or a dedicated test machine.
# This deliberately leaves its installed app and reports for inspection.
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Use an elevated PowerShell in a disposable clean Windows test environment.'
}
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
if ([IO.Path]::GetExtension($installer) -ne '.exe') { throw 'Choose the Cobble installer executable.' }
$roots = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$existing = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Cobble($|\s)' })
if ($existing.Count) { throw 'An existing Cobble installation was found. Use a clean disposable test environment instead.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Choose a new output directory to preserve previous test evidence.' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$installDir = Join-Path $output 'installed-app'
$runDir = Join-Path $output 'run'
$null = New-Item -ItemType Directory -Path $runDir
$install = Start-Process -FilePath $installer -ArgumentList @('/S', ('/D=' + $installDir)) -Wait -PassThru -WindowStyle Hidden
if ($install.ExitCode -notin @(0, 3010)) { throw "Installer failed: $($install.ExitCode)" }
$exe = Join-Path $installDir 'Cobble.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable is missing.' }
$resources = Join-Path $installDir 'resources'
$voice = Join-Path $resources 'voice'
$manifest = Get-Content -LiteralPath (Join-Path $voice 'runtime.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
  if ($file.name -notmatch '^[\w.-]+$') { throw 'Unsafe voice manifest entry.' }
  $hash = (Get-FileHash -LiteralPath (Join-Path $voice $file.name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $file.sha256) { throw "Voice integrity failed: $($file.name)" }
}
$gitDir = Join-Path $resources 'git'
$gitManifest = Get-Content -LiteralPath (Join-Path $gitDir 'COBBLE-RUNTIME.json') -Raw | ConvertFrom-Json
foreach ($file in $gitManifest.files) {
  if ($file.name.Contains('..') -or $file.name -match '^/|[\\:]') { throw 'Unsafe Git manifest entry.' }
  $hash = (Get-FileHash -LiteralPath (Join-Path $gitDir $file.name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $file.sha256) { throw "Git integrity failed: $($file.name)" }
}
$worker = Join-Path $resources 'review\review-worker.cjs'
$workerManifest = Get-Content -LiteralPath ($worker + '.manifest.json') -Raw | ConvertFrom-Json
if ($workerManifest.mode -ne 'preflight-only' -or $workerManifest.protocolVersion -ne 1 -or (Get-FileHash -LiteralPath $worker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $workerManifest.sha256) {
  throw 'Review worker integrity failed.'
}
if ([version]$ExpectedVersion -ge [version]'0.4.13') {
  $guard = Join-Path $resources 'review\review-guard.exe'
  $guardManifest = Get-Content -LiteralPath ($guard + '.manifest.json') -Raw | ConvertFrom-Json
  if ($guardManifest.version -ne 1 -or $guardManifest.kind -ne 'windows-job-preflight' -or (Get-FileHash -LiteralPath $guard -Algorithm SHA256).Hash.ToLowerInvariant() -ne $guardManifest.sha256) { throw 'Native resource supervisor integrity failed.' }
}
$redist = Join-Path $resources 'redist\vc_redist.x64.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $redist
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Included Microsoft runtime signature is invalid.' }
$runId = [guid]::NewGuid().ToString()
$names = @('COBBLE_SMOKE_TEST','COBBLE_SMOKE_ID','ELECTRON_RUN_AS_NODE','COBBLE_RENDERER_URL')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  [Environment]::SetEnvironmentVariable('COBBLE_SMOKE_TEST', '1', 'Process')
  [Environment]::SetEnvironmentVariable('COBBLE_SMOKE_ID', $runId, 'Process')
  [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
  [Environment]::SetEnvironmentVariable('COBBLE_RENDERER_URL', $null, 'Process')
  $app = Start-Process -FilePath $exe -WorkingDirectory $runDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'app-output.log') -RedirectStandardError (Join-Path $output 'app-errors.log')
  if (-not $app.WaitForExit(120000)) { $app.Kill(); throw 'Installed app test exceeded two minutes.' }
  $app.WaitForExit()
  if ($app.ExitCode -ne 0) { throw "Installed app test failed: $($app.ExitCode). Inspect the logs." }
  $smoke = Get-Content -LiteralPath (Join-Path $runDir '.cobble\packaged-smoke.json') -Raw | ConvertFrom-Json
  if (-not $smoke.success -or $smoke.runId -ne $runId -or $smoke.version -ne $ExpectedVersion -or $smoke.reviewWorker -ne 'model_not_configured') { throw 'Installed app test evidence is missing or does not match this run/version.' }
  if ([version]$ExpectedVersion -ge [version]'0.4.13' -and $smoke.reviewResourceGuard -ne 'windows-job') { throw 'Installed worker did not verify Windows resource enforcement.' }
  $result = [ordered]@{ version = $ExpectedVersion; runId = $runId; installerSHA256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); success = $true; environment = 'user-supplied clean Windows test machine'; networkIsolationIndependentlyVerified = $false; humanReviewCompleted = $false; semanticReviewEnabled = $false; installedAt = $installDir; checkedAt = [DateTime]::UtcNow.ToString('o') }
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'clean-install-result.json') -Encoding UTF8
  Write-Output "COBBLE_CLEAN_INSTALL_OK: $ExpectedVersion. Evidence: $output"
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
