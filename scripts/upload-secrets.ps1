param(
  [string]$SecretsFile = ".dev.vars",
  [switch]$UseVersions,
  [switch]$DeleteMissing,
  [switch]$DryRun,
  [string[]]$ExcludedKeys = @("CF_ACCOUNT_ID", "GATEWAY_NAME"),
  [string[]]$RequiredKeys = @("MASTER_KEY", "CF_API_TOKEN")
)

if (-not (Test-Path $SecretsFile)) {
  throw "Secrets file not found: $SecretsFile"
}

$excludedPattern = '^(?:' + (($ExcludedKeys | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')='

$content = Get-Content $SecretsFile | Where-Object {
  $_ -and
  $_.Trim() -ne "" -and
  -not $_.TrimStart().StartsWith("#") -and
  $_ -notmatch $excludedPattern
}

if (-not $content -or $content.Count -eq 0) {
  throw "No secrets found to upload from $SecretsFile"
}

$missing = @()
foreach ($required in $RequiredKeys) {
  $line = $content | Where-Object { $_ -match "^${required}=" } | Select-Object -First 1
  if (-not $line -or $line -match "^${required}=$") {
    $missing += $required
  }
}

if ($missing.Count -gt 0) {
  Write-Warning ("Missing or empty required secret(s) in {0}: {1}" -f $SecretsFile, ($missing -join ', '))
}

$secretNames = $content | ForEach-Object {
  ($_ -split '=', 2)[0]
}

Write-Host ("Uploading {0} secret(s): {1}" -f $secretNames.Count, ($secretNames -join ', '))

$payload = ($content -join "`n")

if ($UseVersions) {
  if ($DeleteMissing) {
    throw "-DeleteMissing is not supported together with -UseVersions because Wrangler does not provide a matching versions secret list command for reconciliation."
  }

  if ($DryRun) {
    Write-Host "Dry run: would upload secrets via 'wrangler versions secret bulk'."
    return
  }

  $payload | npx wrangler versions secret bulk
} else {
  if ($DryRun) {
    Write-Host "Dry run: would upload secrets via 'wrangler secret bulk'."
  } else {
    $payload | npx wrangler secret bulk
  }

  if ($DeleteMissing) {
    $remoteSecrets = npx wrangler secret list --format json | ConvertFrom-Json
    $remoteSecretNames = @($remoteSecrets | ForEach-Object { $_.name })
    $staleSecrets = @($remoteSecretNames | Where-Object { $_ -notin $secretNames })

    if ($staleSecrets.Count -eq 0) {
      Write-Host "No stale remote secrets found."
    } else {
      Write-Host ("Found {0} stale remote secret(s): {1}" -f $staleSecrets.Count, ($staleSecrets -join ', '))

      if ($DryRun) {
        Write-Host "Dry run: no remote secrets were deleted."
        return
      }

      $confirmation = Read-Host "Delete these stale remote secrets? Type YES to continue"
      if ($confirmation -ne 'YES') {
        Write-Warning "Deletion cancelled. No remote secrets were deleted."
        return
      }

      foreach ($secretName in $staleSecrets) {
        npx wrangler secret delete $secretName
      }
    }
  }
}