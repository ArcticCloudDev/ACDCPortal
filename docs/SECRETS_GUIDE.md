# ACDC Portal - Secrets & Configuration Guide

This document describes all the secrets and configuration needed for the ACDC Portal, and how to manage them securely.

## Overview of Required Secrets

| Secret | Purpose | Where Used |
|--------|---------|------------|
| `AZURE_CLIENT_ID` | Entra External ID app for user authentication | Frontend (public) |
| `AZURE_TENANT_ID` | Entra tenant for authentication | Frontend (public) |
| `AZURE_CLIENT_SECRET` | Token validation (optional) | API |
| `MAIL_CLIENT_ID` | Graph API app for sending emails | API |
| `MAIL_CLIENT_SECRET` | Graph API authentication | API |
| `MAIL_TENANT_ID` | Graph API tenant | API |
| `SHAREPOINT_CLIENT_ID` | SharePoint/Graph app for file storage | API |
| `SHAREPOINT_CLIENT_SECRET` | SharePoint authentication | API |

## App Registrations Needed

### 1. User Authentication (Entra External ID)
**Purpose:** Allow users to sign in with email OTP

- **Type:** Single Page Application (SPA)
- **Permissions:** Delegated - `openid`, `profile`, `email`, `offline_access`
- **Redirect URIs:** 
  - `http://localhost:4280` (dev)
  - `https://your-swa.azurestaticapps.net` (prod)

### 2. Email Sending (Graph API)
**Purpose:** Send verification codes, invitations, announcements

- **Type:** Daemon/Service (Client Credentials)
- **Permissions:** Application - `Mail.Send`
- **Admin Consent:** Required

### 3. SharePoint File Storage (Graph API)
**Purpose:** Store team submission files in SharePoint

- **Type:** Daemon/Service (Client Credentials)
- **Permissions:** Application - `Sites.ReadWrite.All`, `Files.ReadWrite.All`
- **Admin Consent:** Required

## Setup Scripts

All scripts are in the `/scripts` folder:

### Create SharePoint App Registration
```powershell
.\setup-sharepoint-app.ps1 `
    -TenantId "your-tenant-id" `
    -SharePointSiteUrl "https://yourtenant.sharepoint.com/sites/ACDC"
```

### Create Key Vault and Store Secrets
```powershell
.\setup-keyvault.ps1 `
    -ResourceGroup "rg-acdc-portal" `
    -KeyVaultName "kv-acdc-portal" `
    -Location "norwayeast"
```

## Environment Configuration

### Local Development (`api/local.settings.json`)

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "",
    
    "AZURE_CLIENT_ID": "your-entra-client-id",
    "AZURE_CLIENT_SECRET": "your-entra-client-secret",
    "AZURE_TENANT_ID": "your-entra-tenant-id",
    "ENTRA_ISSUER_DOMAIN": "yourtenant.onmicrosoft.com",
    
    "MAIL_CLIENT_ID": "your-mail-app-client-id",
    "MAIL_CLIENT_SECRET": "your-mail-app-secret",
    "MAIL_TENANT_ID": "your-mail-tenant-id",
    "MAIL_SENDER": "no-reply@yourdomain.com",
    
    "SHAREPOINT_TENANT_ID": "your-sharepoint-tenant-id",
    "SHAREPOINT_CLIENT_ID": "your-sharepoint-client-id",
    "SHAREPOINT_CLIENT_SECRET": "your-sharepoint-secret",
    "SHAREPOINT_SITE_URL": "yourtenant.sharepoint.com:/sites/ACDC",
    "SHAREPOINT_DOC_LIBRARY": "Team Files",
    
    "PORTAL_URL": "http://localhost:4280"
  }
}
```

### Frontend Configuration (`src/js/config.js`)

Only public, non-secret values:
```javascript
const CONFIG = {
    auth: {
        clientId: 'your-entra-client-id',  // Public - used in browser
        tenantId: 'your-entra-tenant-id',   // Public - used in browser
        // NO SECRETS in frontend config!
    }
};
```

## Azure Deployment

### Option 1: Azure Key Vault (Recommended)

1. **Create Key Vault:**
   ```bash
   az keyvault create --name kv-acdc-portal --resource-group rg-acdc-portal
   ```

2. **Store secrets:**
   ```bash
   az keyvault secret set --vault-name kv-acdc-portal --name "mail-client-secret" --value "your-secret"
   ```

3. **Configure Static Web App to use Key Vault references:**
   - In Azure Portal → Static Web App → Configuration
   - Add app setting: `MAIL_CLIENT_SECRET` = `@Microsoft.KeyVault(VaultName=kv-acdc-portal;SecretName=mail-client-secret)`

4. **Enable Managed Identity:**
   ```bash
   az staticwebapp identity assign --name your-swa-name --resource-group rg-acdc-portal
   ```

5. **Grant Key Vault access:**
   ```bash
   # Get the principal ID from the identity command above
   az keyvault set-policy --name kv-acdc-portal --object-id <principal-id> --secret-permissions get list
   ```

### Option 2: Direct App Settings (Simpler but less secure)

In Azure Portal → Static Web App → Configuration → Application settings:

| Name | Value |
|------|-------|
| `MAIL_CLIENT_ID` | `your-value` |
| `MAIL_CLIENT_SECRET` | `your-value` |
| `MAIL_TENANT_ID` | `your-value` |
| `SHAREPOINT_CLIENT_ID` | `your-value` |
| `SHAREPOINT_CLIENT_SECRET` | `your-value` |
| etc. | |

## Security Best Practices

### DO:
- ✅ Use Key Vault for production secrets
- ✅ Use Managed Identity where possible
- ✅ Rotate secrets regularly (set calendar reminders)
- ✅ Use certificates instead of secrets for high-security scenarios
- ✅ Keep `local.settings.json` in `.gitignore`
- ✅ Use different app registrations for dev/prod

### DON'T:
- ❌ Commit secrets to git
- ❌ Put secrets in frontend code
- ❌ Share secrets via email/chat
- ❌ Use the same secret for multiple environments
- ❌ Use secrets that never expire

## Troubleshooting

### "AADSTS700016: Application not found"
- Check the Client ID is correct
- Ensure the app registration exists in the correct tenant

### "Insufficient privileges"
- Admin consent may be required for application permissions
- Run: `az ad app permission admin-consent --id <app-id>`

### "SharePoint site not found"
- Verify the site URL format: `tenant.sharepoint.com:/sites/SiteName`
- Ensure the app has `Sites.ReadWrite.All` permission with admin consent

### "Mail send failed"
- Verify `Mail.Send` application permission is granted
- Check the sender email is valid in Exchange Online
- Ensure admin consent was granted

## Rotation Schedule

| Secret | Rotation Period | How to Rotate |
|--------|-----------------|---------------|
| Client Secrets | 12-24 months | Create new secret, update config, delete old |
| Certificates | 24 months | Generate new cert, upload to Azure, update app |

## Quick Reference: CLI Commands

```bash
# List all app registrations
az ad app list --display-name "ACDC" --query "[].{name:displayName, appId:appId}"

# Create a new client secret
az ad app credential reset --id <app-id> --display-name "New Secret" --years 2

# Grant admin consent
az ad app permission admin-consent --id <app-id>

# List Key Vault secrets
az keyvault secret list --vault-name kv-acdc-portal --query "[].name"

# Get a secret value
az keyvault secret show --vault-name kv-acdc-portal --name secret-name --query value
```
