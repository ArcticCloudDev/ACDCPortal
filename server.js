// Local Development Server - Express.js wrapper for Azure Functions
// This allows us to use Node.js 24 locally while keeping Azure Functions compatible code
// In production, Azure Static Web Apps runs the /api folder as Azure Functions

const express = require('express');
const path = require('path');

const app = express();
const PORT = 4280;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from src folder
app.use(express.static(path.join(__dirname, 'src')));

// Helper to convert Express req/res to Azure Functions context/req
function wrapAzureFunction(handler) {
    return async (req, res) => {
        // Create Azure Functions-like context
        const context = {
            log: (...args) => console.log('[API]', ...args),
            log: Object.assign(
                (...args) => console.log('[API]', ...args),
                { error: (...args) => console.error('[API ERROR]', ...args) }
            ),
            bindingData: {
                ...req.params
            },
            res: null
        };
        
        // Create Azure Functions-like request
        const azureReq = {
            method: req.method,
            body: req.body,
            query: req.query,
            params: req.params,
            headers: req.headers
        };
        
        try {
            // Call the Azure Function handler
            await handler(context, azureReq);
            
            // Send the response
            if (context.res) {
                res.status(context.res.status || 200).json(context.res.body);
            } else {
                res.status(200).json({ message: 'OK' });
            }
        } catch (error) {
            console.error('[API ERROR]', error);
            res.status(500).json({ message: 'Internal server error', error: error.message });
        }
    };
}

// Load Azure Function handlers
const registerInitiate = require('./api/register-initiate/index');
const registerVerify = require('./api/register-verify/index');
const authCheckEmail = require('./api/auth-check-email/index');
const users = require('./api/users/index');
const teams = require('./api/teams/index');
const members = require('./api/members/index');

// API Routes - matching Azure Functions routes
app.post('/api/register-initiate', wrapAzureFunction(registerInitiate));
app.post('/api/register-verify', wrapAzureFunction(registerVerify));
app.post('/api/auth-check-email', wrapAzureFunction(authCheckEmail));

// Users routes
app.get('/api/users', wrapAzureFunction(users));
app.get('/api/users/:id', wrapAzureFunction(users));
app.put('/api/users/:id', wrapAzureFunction(users));

// Teams routes
app.get('/api/teams/:id', wrapAzureFunction(teams));
app.get('/api/teams/:id/:action', wrapAzureFunction(teams));

// Members routes
app.post('/api/members', wrapAzureFunction(members));
app.delete('/api/members/:id', wrapAzureFunction(members));

// SPA fallback - serve index.html for any non-API routes
app.get('*', (req, res) => {
    // Check if it's a specific HTML file
    const htmlPath = path.join(__dirname, 'src', req.path);
    if (req.path.endsWith('.html')) {
        res.sendFile(htmlPath);
    } else if (req.path === '/' || !req.path.includes('.')) {
        res.sendFile(path.join(__dirname, 'src', 'index.html'));
    } else {
        res.sendFile(htmlPath);
    }
});

// Start server
app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('   ACDC Portal - Local Development Server');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`   🌐 Frontend:  http://localhost:${PORT}`);
    console.log(`   🔌 API:       http://localhost:${PORT}/api/*`);
    console.log('');
    console.log('   📁 Static files served from: ./src');
    console.log('   💾 Data stored in: ./data/*.json');
    console.log('');
    console.log('   Note: Verification codes are logged to this console');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
});
