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

This starts:

- Frontend server at `http://localhost:4280`
- Azure Functions API host at `http://localhost:7071`
- Frontend `/api/*` requests are proxied to the Functions host

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

## Troubleshooting

If you see `func: not found`, install Azure Functions Core Tools v4 and restart your terminal.

If you see `Worker runtime cannot be 'None'`, ensure `api/local.settings.json` exists with:

```json
{
	"IsEncrypted": false,
	"Values": {
		"FUNCTIONS_WORKER_RUNTIME": "node",
		"AzureWebJobsStorage": "UseDevelopmentStorage=true"
	}
}
```
