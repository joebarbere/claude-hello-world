# Install the localhost self-signed certificate as a trusted CA on Windows.
# Adds the cert to the LocalMachine\Root certificate store.
# Must be run as Administrator.

#Requires -RunAsAdministrator

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certPath = Join-Path $scriptDir "localhost.crt"

if (-not (Test-Path $certPath)) {
    Write-Error "Certificate not found at: $certPath"
    exit 1
}

Write-Host "Installing certificate into LocalMachine\Root store..."
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
)
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$store.Add($cert)
$store.Close()

Write-Host ""
Write-Host "Done. The localhost certificate is now trusted system-wide."
Write-Host "You may need to restart your browser for the change to take effect."
