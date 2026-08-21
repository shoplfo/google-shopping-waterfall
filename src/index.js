const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const config = require('./config');
const { requireApiKey, requireSession, requirePermission, attachClientScope } = require('./middleware/auth');

const app = express();

// Trust proxy (Railway, Heroku, etc. — needed for secure cookies behind HTTPS termination)
app.set('trust proxy', 1);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));

// Session middleware (in-memory — sessions reset on server restart)
app.use(session({
  secret: config.sessionSecret,
  name: 'swe.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
  },
}));

// Login & reset pages — always accessible (static files)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'login.html'));
});
app.get('/reset-password.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'reset-password.html'));
});

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
  });
});

// Auth routes (login/logout — no session required)
app.use('/api/auth', require('./routes/auth'));

// OAuth routes (callback is unauthenticated — Google redirect can't send headers)
app.use('/api/oauth', require('./routes/oauth'));

// Keyword stats — available to all authenticated users (dashboard overview needs it)
app.get('/api/keywords/stats', requireApiKey, require('./routes/keywords').statsHandler);

// Protected API routes (session OR API key) with RBAC
app.use('/api/clients', requireApiKey, attachClientScope, require('./routes/clients'));
app.use('/api/vendors', requireApiKey, attachClientScope, require('./routes/vendors'));
app.use('/api/keywords', requireApiKey, requirePermission('manage_master_keywords'), require('./routes/keywords'));
app.use('/api/engine', requireApiKey, requirePermission('run_engine'), require('./routes/engine'));
app.use('/api/logs', requireApiKey, attachClientScope, require('./routes/logs'));
app.use('/api/users', requireApiKey, requirePermission('manage_users'), require('./routes/users'));
app.use('/api/settings', requireApiKey, require('./routes/settings'));

// Static assets (chart.min.js etc) — accessible without auth
app.use('/chart.min.js', express.static(path.join(__dirname, '..', 'dashboard', 'chart.min.js')));

// Protected dashboard — require session for all other routes
app.use(requireSession);
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// Catch-all: serve dashboard for any non-API route (session required)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.port, () => {
  console.log(`Shopping Waterfall Engine running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Dashboard: http://localhost:${config.port}`);
  console.log(`API: http://localhost:${config.port}/api`);
});

module.exports = app;
