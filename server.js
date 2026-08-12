// Local Development Server - Express.js wrapper for Azure Functions
// This allows us to use Node.js 24 locally while keeping Azure Functions compatible code
// In production, Azure Static Web Apps runs the /api folder as Azure Functions

const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 4280;
const FUNCTIONS_PORT = process.env.FUNCTIONS_PORT || 7071;

// Forward API traffic to the local Azure Functions host.
app.use('/api', createProxyMiddleware({
    target: `http://127.0.0.1:${FUNCTIONS_PORT}/api`,
    changeOrigin: true,
    logLevel: 'warn'
}));

// Serve static files from src folder
app.use(express.static(path.join(__dirname, 'src')));

// SPA fallback - serve index.html for any non-API routes
app.use((req, res) => {
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
    console.log('   ACDC Portal - Local Frontend Server');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`   🌐 Frontend:  http://localhost:${PORT}`);
    console.log(`   🔌 API Proxy: http://localhost:${PORT}/api/*`);
    console.log(`      → Azure Functions host: http://localhost:${FUNCTIONS_PORT}/api/*`);
    console.log('');
    console.log('   📁 Static files served from: ./src');
    console.log('   ⚙️  Start API separately with: npm --prefix api start');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
});
