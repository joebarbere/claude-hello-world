# Generate a self-signed SSL certificate for localhost.
# Outputs ssl\localhost.crt and ssl\localhost.key in the ssl\ directory.
#
# Requires OpenSSL for Windows. Install via one of:
#   winget:      winget install ShiningLight.OpenSSL
#   Chocolatey:  choco install openssl
#   Git for Windows ships openssl.exe — add Git\usr\bin to PATH if needed.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certOut = Join-Path $scriptDir "localhost.crt"
$keyOut  = Join-Path $scriptDir "localhost.key"

# Locate openssl.exe
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
    # Common Git for Windows path
    $gitOpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
    if (Test-Path $gitOpenSsl) {
        $openssl = $gitOpenSsl
    } else {
        Write-Error @"
openssl not found on PATH.
Install it via one of:
  winget:      winget install ShiningLight.OpenSSL
  Chocolatey:  choco install openssl
  Git for Windows ships openssl.exe (add Git\usr\bin to PATH).
"@
        exit 1
    }
} else {
    $openssl = $openssl.Source
}

& $openssl req -x509 -nodes -newkey rsa:2048 -days 3650 `
    -keyout $keyOut `
    -out    $certOut `
    -subj   "/CN=localhost/O=claude-hello-world/C=US" `
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

if ($LASTEXITCODE -ne 0) {
    Write-Error "openssl failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Certificate generated:"
Write-Host "  $certOut"
Write-Host "  $keyOut"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Rebuild the container image:  npx nx podman-build shell"
Write-Host "  2. Trust the new cert (run as Administrator):  .\ssl\install-cert-windows.ps1"
