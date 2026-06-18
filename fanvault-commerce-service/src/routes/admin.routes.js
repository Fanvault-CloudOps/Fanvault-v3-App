const express = require('express');
const { body } = require('express-validator');
const { authenticate, adminOnly } = require('../middleware/auth.middleware');
const {
  getAuditLogs,
  getInventory,
  updateStock,
  getMetadata,
  upsertMetadata,
  deactivateMetadata,
  generateMetadata,
} = require('../controllers/admin.controller');

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticate, adminOnly);

// ── Audit Logs ────────────────────────────────────────────────────────────────
router.get('/audit-logs', getAuditLogs);

// ── Inventory Management ─────────────────────────────────────────────────────
router.get('/inventory', getInventory);
router.patch('/inventory/:productId', [
  body('stock').isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),
], updateStock);

// ── Metadata (Categories & Franchises) ───────────────────────────────────────
router.get('/metadata/:metaType', getMetadata);
router.post('/metadata/:metaType', [
  body('metaId').notEmpty().withMessage('metaId is required'),
  body('displayName').notEmpty().withMessage('displayName is required'),
], upsertMetadata);
router.delete('/metadata/:metaType/:metaId', deactivateMetadata);

// ── AI Product Metadata Generation ───────────────────────────────────────────
router.post('/generate-metadata', [
  body('imageKey')
    .notEmpty().withMessage('imageKey is required')
    .matches(/^products\/[a-zA-Z0-9\-_.\/]+$/).withMessage('imageKey must start with products/ and contain only safe characters'),
], generateMetadata);

module.exports = router;
