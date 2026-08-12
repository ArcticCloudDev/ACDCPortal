# ACDCPortal
Team registration for ACDC and all portal related things.

## Local Development

### Prerequisites

- Node.js 18+
- npm
- Azure Functions Core Tools v4 (`func` command)

Install Azure Functions Core Tools if needed:

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

### Install dependencies

From the repository root:

```bash
npm install
npm --prefix api install
```

### Start frontend + API together

From the repository root:

```bash
npm run dev
```

This starts all three local services together:

- Azurite local storage emulator in `.azurite/`
- Azure Functions API host at `http://localhost:7071`
- Frontend server at `http://localhost:4280`
- Frontend `/api/*` requests are proxied to the Functions host

The root `dev` script runs:

```bash
npm run dev:storage
npm run dev:api
npm run dev:web
```

`dev:storage` launches Azurite and keeps the local Azure Storage emulator data under `.azurite/` in the repo root.

### Start services separately

Frontend only (root folder):

```bash
npm run dev:web
```

API only (root folder):

```bash
npm run dev:api
```

Or API directly from the `api` folder:

```bash
npm run start
```

### Azure SQL local configuration

The Azure Functions app uses Entra ID authentication for Azure SQL. In `api/local.settings.json`, include the Azure SQL connection values:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "AZURE_SQL_SERVER": "<your-server>.database.windows.net",
    "AZURE_SQL_DATABASE": "<your-database>"
  }
}
```

For local development, SQL access uses `DefaultAzureCredential`, so sign in with:

```bash
az login
```

Your Azure identity must be able to authenticate to the database through Microsoft Entra ID. In practice, this means:

- your developer machine IP must be allowed through the Azure SQL firewall
- your Entra user or group must have database access on the target Azure SQL database

If you see `Worker runtime cannot be 'None'`, ensure `api/local.settings.json` exists with the values above and that the Functions runtime is set to `node`.