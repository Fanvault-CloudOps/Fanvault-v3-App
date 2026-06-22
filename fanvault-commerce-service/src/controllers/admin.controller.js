const { validationResult } = require('express-validator');
const AuditLogRepository  = require('../models/AuditLog');
const MetadataRepository  = require('../models/Metadata');
const ProductRepository   = require('../models/Product');
const { logAuditEvent }   = require('../utils/auditLogger');
const { publishEvent } = require('../utils/eventPublisher');
const {
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getDocClient } = require('../config/db');

// ── GET /api/admin/audit-logs ─────────────────────────────────────────────────
exports.getAuditLogs = async (req, res) => {
  try {
    const { entityType, adminId, limit = 50, lastKey: rawKey } = req.query;
    let lastKey;
    try { lastKey = rawKey ? JSON.parse(Buffer.from(rawKey, 'base64').toString()) : undefined; } catch { lastKey = undefined; }

    let result;
    if (entityType) {
      result = await AuditLogRepository.listByEntityType(entityType, { limit: Number(limit), lastKey });
    } else if (adminId) {
      result = await AuditLogRepository.listByAdmin(adminId, { limit: Number(limit), lastKey });
    } else {
      result = await AuditLogRepository.listAll({ limit: Number(limit), lastKey });
    }

    res.json({
      logs: result.logs,
      pagination: {
        count:   result.logs.length,
        hasMore: result.hasMore,
        nextKey: result.lastKey ? Buffer.from(JSON.stringify(result.lastKey)).toString('base64') : null,
      },
    });
  } catch (err) {
    console.error('[admin] getAuditLogs error:', err.message);
    if (err.name === 'ResourceNotFoundException') {
      return res.status(503).json({
        error: 'Audit log table not found',
        detail: `DynamoDB table '${process.env.DYNAMODB_TABLE_AUDIT_LOGS || 'fanvault-audit-logs'}' does not exist. Check DYNAMODB_TABLE_AUDIT_LOGS env var.`,
      });
    }
    if (err.name === 'ValidationException') {
      return res.status(400).json({ error: 'Invalid query parameters', detail: err.message });
    }
    res.status(500).json({ error: 'Failed to retrieve audit logs' });
  }
};

// ── GET /api/admin/inventory ──────────────────────────────────────────────────
exports.getInventory = async (req, res) => {
  try {
    const { lastKey: rawKey, limit = 100 } = req.query;
    let lastKey;
    try { lastKey = rawKey ? JSON.parse(Buffer.from(rawKey, 'base64').toString()) : undefined; } catch { lastKey = undefined; }

    const { products, lastKey: nextKey, hasMore } = await ProductRepository.list({
      limit: Number(limit),
      lastKey,
    });

    // Return inventory-focused projection
    const inventory = products.map((p) => ({
      productId: p.productId,
      name:      p.name,
      sku:       p.sku,
      category:  p.category,
      franchise: p.franchise,
      stock:     p.stock,
      isActive:  p.isActive,
    }));

    res.json({
      inventory,
      pagination: {
        count:   inventory.length,
        hasMore,
        nextKey: nextKey ? Buffer.from(JSON.stringify(nextKey)).toString('base64') : null,
      },
    });
  } catch (err) {
    console.error('[admin] getInventory error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/admin/inventory/:productId ─────────────────────────────────────
exports.updateStock = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { productId } = req.params;
    const { stock }     = req.body;

    const TABLE = process.env.DYNAMODB_TABLE_PRODUCTS || 'fanvault-products';
    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE,
        Key:                       { productId },
        UpdateExpression:          'SET stock = :stock, updatedAt = :now',
        ExpressionAttributeValues: { ':stock': Number(stock), ':now': new Date().toISOString() },
        ConditionExpression:       'attribute_exists(productId)',
        ReturnValues:              'ALL_NEW',
      })
    );

    logAuditEvent({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     'STOCK_UPDATED',
      entityType: 'inventory',
      entityId:   productId,
      changes:    { stock: Number(stock) },
    });

    // Publish ProductUpdated and InventoryLow events
    publishEvent('ProductUpdated', {
      productId,
      changes: { stock: Number(stock) },
      timestamp: new Date().toISOString()
    });

    if (Number(stock) <= 5) {
      const product = result.Attributes;
      publishEvent('InventoryLow', {
        productId,
        name: product.name,
        sku: product.sku,
        stock: Number(stock),
        timestamp: new Date().toISOString()
      });
    }

    res.json({ message: 'Stock updated', product: result.Attributes });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Product not found' });
    console.error('[admin] updateStock error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/admin/metadata/:metaType ─────────────────────────────────────────
exports.getMetadata = async (req, res) => {
  try {
    const { metaType } = req.params;
    const ALLOWED_TYPES = ['category', 'franchise'];
    if (!ALLOWED_TYPES.includes(metaType))
      return res.status(400).json({ error: `Invalid metaType. Allowed: ${ALLOWED_TYPES.join(', ')}` });

    const items = await MetadataRepository.list(metaType);
    res.json({ metaType, items });
  } catch (err) {
    console.error('[admin] getMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/admin/metadata/:metaType ────────────────────────────────────────
exports.upsertMetadata = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { metaType } = req.params;
    const ALLOWED_TYPES = ['category', 'franchise'];
    if (!ALLOWED_TYPES.includes(metaType))
      return res.status(400).json({ error: `Invalid metaType. Allowed: ${ALLOWED_TYPES.join(', ')}` });

    const { metaId, displayName, description, iconKey, franchiseType, isActive, sortOrder } = req.body;
    if (!metaId) return res.status(400).json({ error: 'metaId is required' });

    const item = await MetadataRepository.upsert(metaType, metaId, {
      displayName, description, iconKey, franchiseType, isActive, sortOrder,
    });

    logAuditEvent({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     'METADATA_UPSERTED',
      entityType: 'category',
      entityId:   `${metaType}:${metaId}`,
      changes:    item,
    });

    res.json({ message: 'Metadata saved', item });
  } catch (err) {
    console.error('[admin] upsertMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/admin/metadata/:metaType/:metaId ──────────────────────────────
exports.deactivateMetadata = async (req, res) => {
  try {
    const { metaType, metaId } = req.params;
    const item = await MetadataRepository.deactivate(metaType, metaId);

    logAuditEvent({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     'METADATA_DEACTIVATED',
      entityType: 'category',
      entityId:   `${metaType}:${metaId}`,
    });

    res.json({ message: 'Entry deactivated', item });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Metadata entry not found' });
    console.error('[admin] deactivateMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/admin/generate-metadata ─────────────────────────────────────────
const axios = require('axios');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:8000';

exports.generateMetadata = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { imageKey } = req.body;

    let aiResponse;
    try {
      const { data } = await axios.post(
        `${AI_SERVICE_URL}/generate-metadata`,
        { imageKey },
        { timeout: 35000 }
      );
      aiResponse = data;
    } catch (httpErr) {
      const status = httpErr.response?.status;
      const body   = httpErr.response?.data;
      if (status === 400) return res.status(400).json(body || { error: 'Invalid image key' });
      if (status === 503) return res.status(503).json(body || { success: false, error: 'AI_UNAVAILABLE' });
      return res.status(503).json({ success: false, error: 'AI_UNAVAILABLE', message: httpErr.message });
    }

    if (!aiResponse.success) {
      return res.status(503).json({
        success: false,
        error:   aiResponse.error,
        details: aiResponse.details,
      });
    }

    logAuditEvent({
      adminId:    req.user.id,
      adminEmail: req.user.email,
      action:     'AI_METADATA_GENERATED',
      entityType: 'product',
      entityId:   imageKey,
      changes:    { provider: aiResponse.provider, latencyMs: aiResponse.latencyMs },
    });

    res.json({
      success:   true,
      data:      aiResponse.data,
      provider:  aiResponse.provider,
      latencyMs: aiResponse.latencyMs,
    });
  } catch (err) {
    console.error('[admin] generateMetadata error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};
