require('dotenv').config();
const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const morgan   = require('morgan');

const productRoutes = require('./routes/product.routes');
const orderRoutes   = require('./routes/order.routes');

const app = express();

// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin:      process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '10kb' }));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) =>
  res.json({
    status:    'ok',
    service:   'fanvault-commerce-service',
    database:  'dynamodb',
    timestamp: new Date().toISOString(),
  })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/products', productRoutes);
app.use('/api/orders',   orderRoutes);

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[commerce-service] Unhandled error:', err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── DynamoDB Init + Server Startup ────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
const { initDynamoDB } = require('./config/db');

initDynamoDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`[commerce-service] Running on port ${PORT} | DB: DynamoDB`)
    );
  })
  .catch((err) => {
    console.error('[commerce-service] Startup error:', err.message);
    process.exit(1);
  });
