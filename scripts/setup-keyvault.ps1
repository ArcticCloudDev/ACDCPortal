# ACDC Portal - Azure Key Vault Setup Script
# Creates a Key Vault and stores all application secrets
# Run with: .\setup-keyvault.ps1 -ResourceGroup "rg-acdc-portal" -Location "norwayeast" -KeyVaultName "kv-acdc-portal"

param(
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,
    
    [Parameter(Mandatory=$true)]
    [string]$KeyVaultName,
    
    [Parameter(Mandatory=$false)]
    [string]$Location = "norwayeast",
    
    [Parameter(Mandatory=$false)]
    [string]$StaticWebAppName  # Optional: Link to Static Web App for managed identity
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "ACDC Portal - Key Vault Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if Azure CLI is installed
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI is not installed. Please install it from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    exit 1
}

# Login check
Write-Host "Checking Azure CLI login status..." -ForegroundColor Yellow
$account = az account show 2>&1 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Logging in to Azure..." -ForegroundColor Yellow
    az login
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to login to Azure"
        exit 1
    }
    $account = az account show | ConvertFrom-Json
}

Write-Host "✓ Logged in as: $($account.user.name)" -ForegroundColor Green
Write-Host "  Subscription: $($account.name)" -ForegroundColor White
Write-Host ""

# Create Resource Group if it doesn't exist
Write-Host "Checking Resource Group..." -ForegroundColor Yellow
$rgExists = az group exists --name $ResourceGroup
if ($rgExists -eq "false") {
    Write-Host "Creating Resource Group: $ResourceGroup" -ForegroundColor Yellow
    az group create --name $ResourceGroup --location $Location | Out-Null
    Write-Host "✓ Resource Group created" -ForegroundColor Green
} else {
    Write-Host "✓ Resource Group exists" -ForegroundColor Green
}
Write-Host ""

# Create Key Vault
Write-Host "Creating Key Vault: $KeyVaultName" -ForegroundColor Yellow
$kvResult = az keyvault create `
    --name $KeyVaultName `
    --resource-group $ResourceGroup `
    --location $Location `
    --enable-rbac-authorization false `
    --sku standard `
    2>&1

if ($LASTEXITCODE -ne 0) {
    if ($kvResult -match "already exists") {
        Write-Host "✓ Key Vault already exists" -ForegroundColor Green
    } else {
        Write-Error "Failed to create Key Vault: $kvResult"
        exit 1
    }
} else {
    Write-Host "✓ Key Vault created" -ForegroundColor Green
}
Write-Host ""

# Get current user's object ID for access policy
$currentUserObjectId = az ad signed-in-user show --query id -o tsv

# Set access policy for current user
Write-Host "Setting access policy for current user..." -ForegroundColor Yellow
az keyvault set-policy `
    --name $KeyVaultName `
    --object-id $currentUserObjectId `
    --secret-permissions get list set delete `
    2>&1 | Out-Null
Write-Host "✓ Access policy set" -ForegroundColor Green
Write-Host ""

# If Static Web App specified, enable managed identity
if ($StaticWebAppName) {
    Write-Host "Configuring Static Web App managed identity..." -ForegroundColor Yellow
    
    # Enable system-assigned managed identity
    $swaIdentity = az staticwebapp identity assign `
        --name $StaticWebAppName `
        --resource-group $ResourceGroup `
        2>&1 | ConvertFrom-Json
    
    if ($LASTEXITCODE -eq 0) {
        $swaPrincipalId = $swaIdentity.principalId
        
        # Grant Key Vault access to the managed identity
        az keyvault set-policy `
            --name $KeyVaultName `
            --object-id $swaPrincipalId `
            --secret-permissions get list `
            2>&1 | Out-Null
        
        Write-Host "✓ Managed identity enabled for Static Web App" -ForegroundColor Green
        Write-Host "  Principal ID: $swaPrincipalId" -ForegroundColor White
    } else {
        Write-Host "⚠️ Could not configure managed identity. You may need to do this manually." -ForegroundColor Yellow
    }
    Write-Host ""
}

# Display secrets that need to be stored
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Secrets to Store in Key Vault" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The following secrets should be stored in Key Vault:" -ForegroundColor Yellow
Write-Host ""
Write-Host "Authentication (Custom OTP + JWT):" -ForegroundColor White
Write-Host "  - jwt-secret              : Secret key for signing JWT tokens (min 32 chars)" -ForegroundColor Gray
Write-Host "  - recaptcha-secret-key    : reCAPTCHA v3 secret key" -ForegroundColor Gray
Write-Host ""
Write-Host "Email (Microsoft Graph):" -ForegroundColor White
Write-Host "  - graph-client-id         : Graph API app client ID" -ForegroundColor Gray
Write-Host "  - graph-client-secret     : Graph API app client secret" -ForegroundColor Gray
Write-Host "  - graph-tenant-id         : Graph API tenant ID" -ForegroundColor Gray
Write-Host ""
Write-Host "SharePoint (if configured):" -ForegroundColor White
Write-Host "  - sharepoint-client-id    : SharePoint app client ID" -ForegroundColor Gray
Write-Host "  - sharepoint-client-secret: SharePoint app client secret" -ForegroundColor Gray
Write-Host "  - sharepoint-site-url     : SharePoint site URL" -ForegroundColor Gray
Write-Host ""

# Interactive secret storage
Write-Host "Would you like to store secrets now? (y/n)" -ForegroundColor Yellow
$storeNow = Read-Host

if ($storeNow -eq 'y') {
    Write-Host ""
    Write-Host "Enter secrets (press Enter to skip):" -ForegroundColor Yellow
    Write-Host ""
    
    # Auth secrets (JWT)
    $jwtSecret = Read-Host "JWT Secret (min 32 chars for production)"
    if ($jwtSecret) {
        az keyvault secret set --vault-name $KeyVaultName --name "jwt-secret" --value $jwtSecret | Out-Null
        Write-Host "  ✓ jwt-secret stored" -ForegroundColor Green
    }
    
    $recaptchaSecret = Read-Host "reCAPTCHA Secret Key"
    if ($recaptchaSecret) {
        az keyvault secret set --vault-name $KeyVaultName --name "recaptcha-secret-key" --value $recaptchaSecret | Out-Null
        Write-Host "  ✓ recaptcha-secret-key stored" -ForegroundColor Green
    }
    
    # Graph/Email secrets
    $graphClientId = Read-Host "Graph Client ID (for email)"
    if ($graphClientId) {
        az keyvault secret set --vault-name $KeyVaultName --name "graph-client-id" --value $graphClientId | Out-Null
        Write-Host "  ✓ graph-client-id stored" -ForegroundColor Green
    }
    
    $graphClientSecret = Read-Host "Graph Client Secret"
    if ($graphClientSecret) {
        az keyvault secret set --vault-name $KeyVaultName --name "graph-client-secret" --value $graphClientSecret | Out-Null
        Write-Host "  ✓ graph-client-secret stored" -ForegroundColor Green
    }
    
    $graphTenantId = Read-Host "Graph Tenant ID"
    if ($graphTenantId) {
        az keyvault secret set --vault-name $KeyVaultName --name "graph-tenant-id" --value $graphTenantId | Out-Null
        Write-Host "  ✓ graph-tenant-id stored" -ForegroundColor Green
    }
    
    # SharePoint secrets
    Write-Host ""
    Write-Host "SharePoint secrets (optional):" -ForegroundColor Yellow
    
    $spClientId = Read-Host "SharePoint Client ID"
    if ($spClientId) {
        az keyvault secret set --vault-name $KeyVaultName --name "sharepoint-client-id" --value $spClientId | Out-Null
        Write-Host "  ✓ sharepoint-client-id stored" -ForegroundColor Green
    }
    
    $spClientSecret = Read-Host "SharePoint Client Secret"
    if ($spClientSecret) {
        az keyvault secret set --vault-name $KeyVaultName --name "sharepoint-client-secret" --value $spClientSecret | Out-Null
        Write-Host "  ✓ sharepoint-client-secret stored" -ForegroundColor Green
    }
    
    $spSiteUrl = Read-Host "SharePoint Site URL"
    if ($spSiteUrl) {
        az keyvault secret set --vault-name $KeyVaultName --name "sharepoint-site-url" --value $spSiteUrl | Out-Null
        Write-Host "  ✓ sharepoint-site-url stored" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Key Vault Configuration" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Key Vault Name: $KeyVaultName" -ForegroundColor Green
Write-Host "Key Vault URI:  https://$KeyVaultName.vault.azure.net/" -ForegroundColor Green
Write-Host ""

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Next Steps" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. For local development, add to local.settings.json:" -ForegroundColor White
Write-Host '   "KEY_VAULT_NAME": "' + $KeyVaultName + '"' -ForegroundColor Gray
Write-Host ""
Write-Host "2. For Azure deployment, configure as App Settings:" -ForegroundColor White
Write-Host "   - Use Key Vault references: @Microsoft.KeyVault(VaultName=$KeyVaultName;SecretName=secret-name)" -ForegroundColor Gray
Write-Host ""
Write-Host "3. List stored secrets:" -ForegroundColor White
Write-Host "   az keyvault secret list --vault-name $KeyVaultName --query '[].name' -o tsv" -ForegroundColor Gray
Write-Host ""
