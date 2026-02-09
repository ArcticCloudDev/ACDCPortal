# ACDC Portal - SharePoint App Registration Setup Script
# This script creates an Azure AD App Registration for SharePoint file access
# Run with: .\setup-sharepoint-app.ps1 -TenantId "your-tenant-id" -SharePointSiteUrl "https://yourtenant.sharepoint.com/sites/ACDC"

param(
    [Parameter(Mandatory=$true)]
    [string]$TenantId,
    
    [Parameter(Mandatory=$true)]
    [string]$SharePointSiteUrl,
    
    [Parameter(Mandatory=$false)]
    [string]$AppName = "ACDC Portal - SharePoint Access",
    
    [Parameter(Mandatory=$false)]
    [switch]$UseCertificate  # Use certificate instead of client secret (more secure)
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "ACDC Portal - SharePoint App Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Azure CLI is installed
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI is not installed. Please install it from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    exit 1
}

# Login check
Write-Host "Checking Azure CLI login status..." -ForegroundColor Yellow
$account = az account show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Logging in to Azure..." -ForegroundColor Yellow
    az login --tenant $TenantId
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to login to Azure"
        exit 1
    }
}

Write-Host "✓ Logged in to Azure" -ForegroundColor Green
Write-Host ""

# Define Microsoft Graph API permissions for SharePoint
# Sites.ReadWrite.All - Read and write items in all site collections
# Files.ReadWrite.All - Read and write all files (alternative, more granular)
$graphApiId = "00000003-0000-0000-c000-000000000000"  # Microsoft Graph

# Permission IDs (Application permissions, not delegated)
$permissions = @(
    @{
        id = "9492366f-7969-46a4-8d15-ed1a20078fff"  # Sites.ReadWrite.All
        type = "Role"  # Application permission
    },
    @{
        id = "01d4889c-1287-42c6-ac1f-5d1e02578ef6"  # Files.ReadWrite.All
        type = "Role"
    }
)

# Create the App Registration
Write-Host "Creating App Registration: $AppName" -ForegroundColor Yellow

$appJson = az ad app create `
    --display-name $AppName `
    --sign-in-audience "AzureADMyOrg" `
    --required-resource-accesses "[{\"resourceAppId\":\"$graphApiId\",\"resourceAccess\":[{\"id\":\"9492366f-7969-46a4-8d15-ed1a20078fff\",\"type\":\"Role\"},{\"id\":\"01d4889c-1287-42c6-ac1f-5d1e02578ef6\",\"type\":\"Role\"}]}]" `
    2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create app registration: $appJson"
    exit 1
}

$app = $appJson | ConvertFrom-Json
$appId = $app.appId
$objectId = $app.id

Write-Host "✓ App Registration created" -ForegroundColor Green
Write-Host "  App (Client) ID: $appId" -ForegroundColor White
Write-Host "  Object ID: $objectId" -ForegroundColor White
Write-Host ""

# Create Service Principal for the app
Write-Host "Creating Service Principal..." -ForegroundColor Yellow
$spJson = az ad sp create --id $appId 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Service Principal may already exist, continuing..." -ForegroundColor Yellow
}
Write-Host "✓ Service Principal created/verified" -ForegroundColor Green
Write-Host ""

# Create credential (secret or certificate)
if ($UseCertificate) {
    Write-Host "Creating self-signed certificate..." -ForegroundColor Yellow
    
    $certName = "ACDC-SharePoint-Cert"
    $certPath = ".\$certName.pfx"
    $certPassword = [System.Guid]::NewGuid().ToString()
    
    # Create self-signed certificate
    $cert = New-SelfSignedCertificate `
        -Subject "CN=$AppName" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -KeyExportPolicy Exportable `
        -KeySpec Signature `
        -KeyLength 2048 `
        -KeyAlgorithm RSA `
        -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears(2)
    
    # Export to PFX
    $securePassword = ConvertTo-SecureString -String $certPassword -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $certPath -Password $securePassword | Out-Null
    
    # Export public key for Azure
    $certBase64 = [System.Convert]::ToBase64String($cert.RawData)
    
    # Add certificate to app registration
    az ad app credential reset --id $appId --cert $certBase64 --append 2>&1 | Out-Null
    
    Write-Host "✓ Certificate created and attached" -ForegroundColor Green
    Write-Host "  Certificate file: $certPath" -ForegroundColor White
    Write-Host "  Certificate password: $certPassword" -ForegroundColor White
    Write-Host "  ⚠️  Store these securely and delete from disk after uploading to Key Vault!" -ForegroundColor Yellow
    
    $credentialInfo = @{
        type = "certificate"
        path = $certPath
        password = $certPassword
        thumbprint = $cert.Thumbprint
    }
} else {
    Write-Host "Creating Client Secret (valid for 2 years)..." -ForegroundColor Yellow
    
    $secretJson = az ad app credential reset `
        --id $appId `
        --display-name "ACDC Portal Secret" `
        --years 2 `
        --append `
        2>&1
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create client secret: $secretJson"
        exit 1
    }
    
    $secret = $secretJson | ConvertFrom-Json
    $clientSecret = $secret.password
    
    Write-Host "✓ Client Secret created" -ForegroundColor Green
    
    $credentialInfo = @{
        type = "secret"
        value = $clientSecret
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "IMPORTANT: Admin Consent Required!" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "An admin must grant consent for the application permissions." -ForegroundColor Yellow
Write-Host "Run this command or visit the Azure Portal:" -ForegroundColor Yellow
Write-Host ""
Write-Host "az ad app permission admin-consent --id $appId" -ForegroundColor White
Write-Host ""
Write-Host "Or visit:" -ForegroundColor Yellow
Write-Host "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/$appId" -ForegroundColor White
Write-Host ""

# Output configuration
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Configuration for local.settings.json" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$config = @{
    SHAREPOINT_TENANT_ID = $TenantId
    SHAREPOINT_CLIENT_ID = $appId
    SHAREPOINT_SITE_URL = $SharePointSiteUrl
}

if ($credentialInfo.type -eq "secret") {
    $config.SHAREPOINT_CLIENT_SECRET = $clientSecret
    Write-Host "Add these to your local.settings.json (Values section):" -ForegroundColor Yellow
} else {
    $config.SHAREPOINT_CERT_THUMBPRINT = $credentialInfo.thumbprint
    Write-Host "Add these to your local.settings.json and upload cert to Key Vault:" -ForegroundColor Yellow
}

Write-Host ""
$config | ConvertTo-Json | Write-Host -ForegroundColor Green
Write-Host ""

# Save config to file
$configPath = ".\sharepoint-config.json"
$config | ConvertTo-Json | Out-File -FilePath $configPath -Encoding UTF8
Write-Host "Configuration saved to: $configPath" -ForegroundColor Green
Write-Host "⚠️  Delete this file after copying values to secure storage!" -ForegroundColor Yellow
Write-Host ""

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Next Steps" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Grant admin consent (command above)" -ForegroundColor White
Write-Host "2. Create a Document Library in SharePoint site" -ForegroundColor White
Write-Host "3. Add configuration to Azure Key Vault or local.settings.json" -ForegroundColor White
Write-Host "4. Test the connection using the API" -ForegroundColor White
Write-Host ""
