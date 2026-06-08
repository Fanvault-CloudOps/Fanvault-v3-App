require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');

const app = express();

// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10kb' }));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      100,
  message:  { error: 'Too many requests, please try again later.' },
});
app.use('/api/auth', authLimiter);

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({
    status:    'ok',
    service:   'fanvault-user-auth-service',
    database:  'dynamodb',
    timestamp: new Date().toISOString(),
  })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/users', userRoutes);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[user-auth-service] Unhandled error:', err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── DynamoDB Init + Server Startup ────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const { initDynamoDB } = require('./config/db');

initDynamoDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`[user-auth-service] Running on port ${PORT} | DB: DynamoDB`)
    );
  })
  .catch((err) => {
    console.error('[user-auth-service] Startup error:', err.message);
    process.exit(1);
  });
