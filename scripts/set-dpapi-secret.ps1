param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "OPENDART_API_KEY",
    "KIWOOM_APP_KEY",
    "KIWOOM_APP_SECRET",
    "KIWOOM_BASE_URL",
    "KIWOOM_BASE_URLS",
    "KIWOOM_MARKETS",
    "KIWOOM_REQUIRE_UNIVERSE",
    "KIWOOM_STOCK_INFO_PATH"
  )]
  [string] $Name,

  [Parameter(Mandatory = $true)]
  [string] $Value,

  [string] $Path = ".\secrets\stockmobile.dpapi.json"
)

$resolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
$directory = Split-Path -Parent $resolvedPath
New-Item -ItemType Directory -Force -Path $directory | Out-Null

if (Test-Path $resolvedPath) {
  $secrets = Get-Content -Raw -Path $resolvedPath | ConvertFrom-Json -AsHashtable
} else {
  $secrets = @{}
}

$secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
$secrets[$Name] = ConvertFrom-SecureString -SecureString $secure
$secrets | ConvertTo-Json | Set-Content -Path $resolvedPath -Encoding UTF8

Write-Host "Saved DPAPI secret '$Name' to $resolvedPath"
Write-Host "Run the service under the same Windows account that created this file, or recreate the file as the service account."
