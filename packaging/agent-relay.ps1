param([string]$Agent, [string]$Event, [string]$Workspace, [string]$PairingFile)
# Never block or continue an agent loop. Missing/closed Cobble falls back to file observation.
$ErrorActionPreference = 'Stop'
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 1000000) { exit 0 }
  $payload = $raw | ConvertFrom-Json
  $pair = Get-Content -Raw -LiteralPath $PairingFile | ConvertFrom-Json
  if ($pair.token -notmatch '^[a-f0-9]{64}$' -or $pair.port -lt 1 -or $pair.port -gt 65535 -or $pair.workspace -ne $Workspace) { exit 0 }
  $session = $payload.session_id
  if (-not $session) { $session = $payload.conversation_id }
  $message = $payload.last_assistant_message
  if (-not $message) { $message = $payload.text }
  if ($message -and $message.Length -gt 60000) { $message = $message.Substring($message.Length - 60000) }
  $body = @{ agent=$Agent; event=$Event; workspace=$Workspace; sessionId=$session; message=$message; prompt=$payload.prompt } | ConvertTo-Json -Compress -Depth 6
  $response = Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $pair.port + '/agent') -Headers @{Authorization=('Bearer ' + $pair.token)} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 7
  if ($response.context) {
    if ($Agent -eq 'claude' -and $Event -eq 'context') { @{hookSpecificOutput=@{hookEventName='UserPromptSubmit';additionalContext=$response.context}} | ConvertTo-Json -Compress -Depth 6 }
    elseif ($Agent -eq 'cursor') { @{additional_context=$response.context} | ConvertTo-Json -Compress -Depth 6 }
  }
} catch { }
exit 0
