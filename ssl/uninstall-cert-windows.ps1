# Remove the localhost self-signed certificate from the Windows trust store.
# Removes the cert from LocalMachine\Root by thumbprint matching the certificate file.
# Must be run as Administrator.

#Requires -RunAsAdministrator

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certPath = Join-Path $scriptDir "localhost.crt"

# Load the certificate to get its thumbprint for exact matching
if (Test-Path $certPath) {
    $refCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
    $thumbprint = $refCert.Thumbprint
} else {
    # Fall back to matching by subject if the cert file is missing
    $thumbprint = $null
    Write-Warning "Certificate file not found at $certPath — will match by subject CN=localhost instead."
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
)
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

if ($thumbprint) {
    $certs = $store.Certificates | Where-Object { $_.Thumbprint -eq $thumbprint }
} else {
    $certs = $store.Certificates | Where-Object {
        $_.Subject -like "*CN=localhost*" -and $_.Issuer -like "*claude-hello-world*"
    }
}

if ($certs.Count -eq 0) {
    Write-Host "Certificate not found in LocalMachine\Root store. Nothing to remove."
    $store.Close()
    exit 0
}

foreach ($cert in $certs) {
    Write-Host "Removing: $($cert.Subject) [$($cert.Thumbprint)]"
    $store.Remove($cert)
}
$store.Close()

Write-Host ""
Write-Host "Done. The localhost certificate has been removed from the trust store."
Write-Host "You may need to restart your browser for the change to take effect."
