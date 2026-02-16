# Azure Deployment Guide

## Overview
This guide walks through deploying the ACDC Portal to Azure using Azure Static Web Apps.

## Prerequisites
- Azure account with an active subscription
- GitHub repository (already set up at: https://github.com/thomassandsor/ACDCPortal)
- Azure CLI (optional, for command-line deployment)

## Step 1: Create Azure Static Web App

### Option A: Using Azure Portal (Recommended for first deployment)

1. **Sign in to Azure Portal**
   - Go to https://portal.azure.com
   - Sign in with your Azure account

2. **Create Static Web App Resource**
   - Click "Create a resource"
   - Search for "Static Web Apps"
   - Click "Create"

3. **Configure Basic Settings**
   - **Subscription**: Select your Azure subscription
   - **Resource Group**: Create new or use existing (e.g., "rg-acdc-portal")
   - **Name**: Choose a name (e.g., "acdc-portal")
   - **Plan type**: Free (for development/testing) or Standard (for production)
   - **Region**: Choose the region closest to your users
   - **Deployment source**: GitHub

4. **Configure GitHub Integration**
   - Click "Sign in with GitHub"
   - Authorize Azure Static Web Apps
   - **Organization**: Select your GitHub organization
   - **Repository**: Select "ACDCPortal"
   - **Branch**: Select "main"

5. **Build Configuration**
   - **Build Presets**: Custom
   - **App location**: `/src`
   - **Api location**: `/api`
   - **Output location**: (leave empty)

6. **Review and Create**
   - Click "Review + create"
   - Click "Create"

### Option B: Using Azure CLI

```bash
# Login to Azure
az login

# Create resource group (if needed)
az group create --name rg-acdc-portal --location eastus

# Create Static Web App
az staticwebapp create \
  --name acdc-portal \
  --resource-group rg-acdc-portal \
  --source https://github.com/thomassandsor/ACDCPortal \
  --location eastus \
  --branch main \
  --app-location "/src" \
  --api-location "/api" \
  --output-location "" \
  --login-with-github
```

## Step 2: Configure GitHub Secrets

After creating the Static Web App, Azure will automatically:
1. Add a GitHub Actions workflow to your repository (if one doesn't exist)
2. Create a GitHub secret called `AZURE_STATIC_WEB_APPS_API_TOKEN`

**Manual Configuration (if needed):**

1. Go to your Azure Static Web App in the Azure Portal
2. Click on "Manage deployment token" in the Overview page
3. Copy the deployment token
4. Go to your GitHub repository settings
5. Navigate to Settings > Secrets and variables > Actions
6. Click "New repository secret"
7. Name: `AZURE_STATIC_WEB_APPS_API_TOKEN`
8. Value: Paste the deployment token
9. Click "Add secret"

## Step 3: Deploy

The GitHub Actions workflow is already configured at `.github/workflows/azure-static-web-apps.yml`.

### Automatic Deployment
- Every push to the `main` branch will trigger a deployment
- Pull requests will create preview environments

### Manual Deployment
You can also trigger a deployment manually:
1. Go to your GitHub repository
2. Click on "Actions"
3. Select the "Azure Static Web Apps CI/CD" workflow
4. Click "Run workflow"
5. Select the branch and click "Run workflow"

## Step 4: Verify Deployment

1. In Azure Portal, go to your Static Web App resource
2. Click on "Browse" to open your deployed site
3. The URL will be something like: `https://<app-name>.azurestaticapps.net`

## Current State

### What Works
- Frontend HTML/CSS/JS files are deployed
- Static file serving
- Basic routing with fallback to index.html

### What Doesn't Work Yet (Expected)
- API endpoints (need Azure Functions setup)
- Authentication (needs Azure AD/Entra ID configuration)
- Database/Storage connections (needs Azure resources)
- Email functionality (needs configuration)

## Next Steps

1. **Configure Azure Functions**
   - Set up Azure Functions for the API
   - Configure local.settings.json for deployment
   - Add necessary connection strings

2. **Set Up Azure AD (Entra ID)**
   - Register the application
   - Configure redirect URIs
   - Set up API permissions

3. **Configure Azure Storage**
   - Create Storage Account
   - Set up containers for data
   - Configure connection strings

4. **Add Application Settings**
   - Configure environment variables in Azure
   - Add secrets to Key Vault
   - Link Key Vault to Static Web App

5. **Set Up Custom Domain (Optional)**
   - Add custom domain in Azure Portal
   - Configure DNS records
   - Enable HTTPS

## Useful Commands

```bash
# View Static Web App details
az staticwebapp show --name acdc-portal --resource-group rg-acdc-portal

# List deployment history
az staticwebapp show --name acdc-portal --resource-group rg-acdc-portal --query "defaultHostname"

# View functions in API
az staticwebapp functions list --name acdc-portal --resource-group rg-acdc-portal
```

## Troubleshooting

### Deployment fails
- Check GitHub Actions logs in your repository
- Verify the `AZURE_STATIC_WEB_APPS_API_TOKEN` secret is set correctly
- Ensure app_location and api_location paths are correct

### Site loads but shows 404
- Check that `staticwebapp.config.json` is in the root of your repository
- Verify routing configuration

### API endpoints return 404
- Ensure Azure Functions are properly configured
- Check that api_location is set to `/api` in the workflow

## Resources

- [Azure Static Web Apps Documentation](https://docs.microsoft.com/azure/static-web-apps/)
- [GitHub Actions for Azure](https://docs.microsoft.com/azure/developer/github/github-actions)
- [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/)
