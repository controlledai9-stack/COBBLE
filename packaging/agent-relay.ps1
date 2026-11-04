param([string]$Agent, [string]$Event, [string]$Workspace, [string]$PairingFile)
# Observe only. No block, deny, followup_message, or agent-loop continuation instructions.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Hash([string]$value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Save([string]$file, $value) {
  $temporary = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress -Depth 8), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $file -Force
}
function DeleteLocal([string]$file, [string]$directory) {
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file)) -ne [IO.Path]::GetFullPath($directory)) { throw 'Invalid relay path' }
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
try {
  if ($Agent -notin @('claude', 'cursor', 'gemini')) { exit 0 }
  $builder = New-Object Text.StringBuilder
  $chunk = New-Object char[] 4096
  while (($count = [Console]::In.Read($chunk, 0, $chunk.Length)) -gt 0) {
    [void]$builder.Append($chunk, 0, $count)
    if ($builder.Length -gt 1000000) { exit 0 }
  }
  $raw = $builder.ToString()
  $payload = $raw | ConvertFrom-Json
  $pair = Get-Content -Raw -LiteralPath $PairingFile | ConvertFrom-Json
  if ($pair.token -notmatch '^[a-f0-9]{64}$' -or $pair.port -lt 1 -or $pair.port -gt 65535 -or $pair.workspace -ne $Workspace) { exit 0 }
  $session = $payload.conversation_id
  if (-not $session) { $session = $payload.session_id }
  if (-not $session -or $session.Length -gt 200) { exit 0 }
  if ($Agent -eq 'cursor' -and $Event -eq 'complete' -and $payload.status -in @('aborted', 'error')) { $Event = 'cancel' }
  $occurred = [DateTimeOffset]::UtcNow
  $timestamped = $false
  if ($payload.timestamp) {
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$payload.timestamp, [ref]$parsed)) { $occurred = $parsed; $timestamped = $true }
  }
  $native = $payload.prompt_id
  if ($Agent -eq 'cursor') { $native = $payload.generation_id }
  $message = $payload.last_assistant_message
  if (-not $message) { $message = $payload.prompt_response }
  if (-not $message) { $message = $payload.text }
  if ($message -and $message.Length -gt 12000) { $message = $message.Substring($message.Length - 12000) }
  $prompt = [string]$payload.prompt
  if ($prompt.Length -gt 4000) { $prompt = $prompt.Substring(0, 4000) }
  $directory = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PairingFile))) ('agent-relay-' + (Hash $Workspace).Substring(0, 16))
  [void][IO.Directory]::CreateDirectory($directory)
  if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 0 }
  $sessionKey = Hash ($Agent + '|' + $session)
  $stateFile = Join-Path $directory ('s-' + $sessionKey + '.json')
  $mutex = New-Object Threading.Mutex($false, ('Local\CobbleRelay-' + (Hash $directory)))
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(1500) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    foreach ($old in @(Get-ChildItem -LiteralPath $directory -File -Filter '*.json')) {
      if ($old.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-8)) { DeleteLocal $old.FullName $directory }
    }
    if (-not (Test-Path -LiteralPath $stateFile) -and @(Get-ChildItem -LiteralPath $directory -File -Filter 's-*.json').Count -ge 128) { exit 0 }
    $state = @{sequence=0; recent=@(); turnId=$null; identity='missing'; startedAt=$null}
    if (Test-Path -LiteralPath $stateFile) { $state = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json }
    $fingerprint = Hash ($Agent + '|' + $Event + '|' + $raw)
    $previous = @($state.recent | Where-Object { $_.fingerprint -eq $fingerprint }) | Select-Object -Last 1
    # Identical old payloads without a native ID/timestamp cannot prove a repeated prompt is a retry.
    if ($Event -eq 'context' -and -not $native -and -not $timestamped) { $previous = $null }
    if ($previous) {
      $identity = $previous.identity; $turn = $previous.turnId; $sequence = $previous.sequence; $eventId = $previous.eventId; $occurred = [DateTimeOffset]::Parse($previous.occurredAt)
    } else {
      $identity = 'missing'; $turn = $null
      if ($native) { $turn = [string]$native; $identity = 'native' }
      elseif ($Event -eq 'context') { $turn = if ($timestamped) { Hash ($session + '|' + $occurred.ToString('o')) } else { [Guid]::NewGuid().ToString() }; $identity = 'session-local' }
      elseif ($state.identity -eq 'session-local' -and $state.turnId -and $timestamped -and $state.startedAt -and $occurred -ge [DateTimeOffset]::Parse($state.startedAt)) { $turn = $state.turnId; $identity = 'session-local' }
      if ($Event -eq 'session') { $turn = $null; $identity = 'missing' }
      $sequence = [long]$state.sequence + 1
      $eventId = Hash ($fingerprint + '|' + $turn)
      $state.sequence = $sequence
      if ($Event -eq 'context') { $state.turnId = $turn; $state.identity = $identity; $state.startedAt = $occurred.ToString('o') }
      $entry = @{fingerprint=$fingerprint; identity=$identity; turnId=$turn; sequence=$sequence; eventId=$eventId; occurredAt=$occurred.ToString('o')}
      $state.recent = @(@($state.recent) + $entry | Select-Object -Last 64)
      Save $stateFile $state
    }
    $body = @{protocolVersion=1; agent=$Agent; event=$Event; workspace=$Workspace; sessionId=[string]$session; eventId=$eventId; sequence=$sequence; identity=$identity; occurredAt=$occurred.ToUniversalTime().ToString('o'); prompt=$prompt}
    if ($turn) { $body.turnId = $turn }
    if ($message) { $body.message = [string]$message }
    if ($payload.cursor_version) { $body.providerVersion = [string]$payload.cursor_version }
    $queueFile = Join-Path $directory ('q-' + $eventId + '.json')
    if (Test-Path -LiteralPath $queueFile) { $body = Get-Content -Raw -LiteralPath $queueFile | ConvertFrom-Json }
    elseif (@(Get-ChildItem -LiteralPath $directory -File -Filter 'q-*.json').Count -lt 128) { Save $queueFile $body }
  } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
  # Do not hold the session mutex while Cobble inspects files. Concurrent delivery is idempotent.
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $result = $null
  foreach ($queued in @(Get-ChildItem -LiteralPath $directory -File -Filter 'q-*.json' | Sort-Object @{Expression={if ($_.Name -eq ('q-' + $eventId + '.json') -and $Event -in @('context','session')) { 0 } else { 1 }}},LastWriteTimeUtc | Select-Object -First 4)) {
    if ($watch.ElapsedMilliseconds -gt 3500) { break }
    try {
      $send = Get-Content -Raw -LiteralPath $queued.FullName | ConvertFrom-Json
      if ([DateTimeOffset]::Parse($send.occurredAt) -lt [DateTimeOffset]::UtcNow.AddDays(-7)) { DeleteLocal $queued.FullName $directory; continue }
      if ($send.eventId -ne $eventId -or ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($send.occurredAt)).TotalSeconds -gt 5) { $send | Add-Member -NotePropertyName replayed -NotePropertyValue $true -Force }
      $response = Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $pair.port + '/agent') -Headers @{Authorization=('Bearer ' + $pair.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($send | ConvertTo-Json -Compress -Depth 8))) -TimeoutSec 2 -MaximumRedirection 0
      if ($response.ok -and $response.eventId -eq $send.eventId) { DeleteLocal $queued.FullName $directory }
      if ($send.eventId -eq $eventId) { $result = $response }
    } catch { break }
  }
  if ($result.context) {
    if ($Agent -eq 'claude' -and $Event -eq 'context') { @{hookSpecificOutput=@{hookEventName='UserPromptSubmit';additionalContext=$result.context}} | ConvertTo-Json -Compress -Depth 6 }
    elseif ($Agent -eq 'gemini' -and $Event -eq 'context') { @{hookSpecificOutput=@{hookEventName='BeforeAgent';additionalContext=$result.context}} | ConvertTo-Json -Compress -Depth 6 }
    elseif ($Agent -eq 'cursor' -and $Event -eq 'session') { @{additional_context=$result.context} | ConvertTo-Json -Compress -Depth 6 }
  }
} catch { }
exit 0
