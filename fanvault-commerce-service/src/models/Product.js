const {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getDocClient } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const TABLE = () => process.env.DYNAMODB_TABLE_PRODUCTS || 'fanvault-products';

// ── ProductRepository ─────────────────────────────────────────────────────────
// Replaces the Mongoose Product model.
// Supports filtering, pagination via LastEvaluatedKey, soft-delete, and bulk fetch.

const ProductRepository = {
  // ── List products (with optional filters) ─────────────────────────────────
  // Uses GSI when category is provided; falls back to Scan for cross-category queries.
  async list({ category, franchise, franchiseType, minPrice, maxPrice, search, limit = 20, lastKey } = {}) {
    const expressionNames  = {};
    const expressionValues = {};
    const filters          = [];

    // Always filter by isActive
    filters.push('#isActive = :active');
    expressionNames['#isActive']  = 'isActive';
    expressionValues[':active']   = true;

    if (franchiseType) {
      filters.push('franchiseType = :ftype');
      expressionValues[':ftype'] = franchiseType;
    }
    if (minPrice !== undefined) {
      filters.push('price >= :minPrice');
      expressionValues[':minPrice'] = Number(minPrice);
    }
    if (maxPrice !== undefined) {
      filters.push('price <= :maxPrice');
      expressionValues[':maxPrice'] = Number(maxPrice);
    }
    if (search) {
      // Case-insensitive substring search on name (DynamoDB has no full-text index)
      filters.push('contains(#name, :search)');
      expressionNames['#name']   = 'name';
      expressionValues[':search'] = search;
    }

    const filterExpression = filters.join(' AND ');

    let result;

    if (category && franchise) {
      // GSI-2: category-franchise-index — most efficient
      result = await getDocClient().send(
        new QueryCommand({
          TableName:                 TABLE(),
          IndexName:                 'category-franchise-index',
          KeyConditionExpression:    'category = :cat AND franchise = :fran',
          FilterExpression:          filterExpression,
          ExpressionAttributeNames:  Object.keys(expressionNames).length ? expressionNames : undefined,
          ExpressionAttributeValues: { ...expressionValues, ':cat': category, ':fran': franchise },
          Limit:                     Number(limit),
          ExclusiveStartKey:         lastKey,
          ScanIndexForward:          false,
        })
      );
    } else if (category) {
      // GSI-2 with only category PK
      result = await getDocClient().send(
        new QueryCommand({
          TableName:                 TABLE(),
          IndexName:                 'category-franchise-index',
          KeyConditionExpression:    'category = :cat',
          FilterExpression:          filterExpression,
          ExpressionAttributeNames:  Object.keys(expressionNames).length ? expressionNames : undefined,
          ExpressionAttributeValues: { ...expressionValues, ':cat': category },
          Limit:                     Number(limit),
          ExclusiveStartKey:         lastKey,
          ScanIndexForward:          false,
        })
      );
    } else {
      // Full Scan (no category filter) — acceptable for capstone scale
      result = await getDocClient().send(
        new ScanCommand({
          TableName:                 TABLE(),
          FilterExpression:          filterExpression,
          ExpressionAttributeNames:  Object.keys(expressionNames).length ? expressionNames : undefined,
          ExpressionAttributeValues: expressionValues,
          Limit:                     Number(limit),
          ExclusiveStartKey:         lastKey,
        })
      );
    }

    return {
      products:    result.Items || [],
      lastKey:     result.LastEvaluatedKey || null, // Pagination cursor
      hasMore:     !!result.LastEvaluatedKey,
    };
  },

  // ── Get a single product by productId ──────────────────────────────────────
  async findById(productId) {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: TABLE(),
        Key:       { productId },
      })
    );
    const item = result.Item;
    return (item && item.isActive) ? item : null;
  },

  // ── Get a product by SKU (sku-index GSI) ───────────────────────────────────
  async findBySku(sku) {
    const result = await getDocClient().send(
      new QueryCommand({
        TableName:                 TABLE(),
        IndexName:                 'sku-index',
        KeyConditionExpression:    'sku = :sku',
        ExpressionAttributeValues: { ':sku': sku },
        Limit:                     1,
      })
    );
    return result.Items?.[0] || null;
  },

  // ── Bulk fetch by array of productIds (BatchGetItem) ───────────────────────
  async bulkFindByIds(ids) {
    if (!ids || ids.length === 0) return [];

    // BatchGetItem supports max 100 keys per request
    const chunks   = [];
    for (let i = 0; i < ids.length; i += 100) {
      chunks.push(ids.slice(i, i + 100));
    }

    const results = [];
    for (const chunk of chunks) {
      const response = await getDocClient().send(
        new BatchGetCommand({
          RequestItems: {
            [TABLE()]: {
              Keys: chunk.map((id) => ({ productId: id })),
            },
          },
        })
      );
      results.push(...(response.Responses?.[TABLE()] || []));
    }

    return results.filter((p) => p.isActive);
  },

  // ── Create a new product ────────────────────────────────────────────────────
  async create(data) {
    // Check SKU uniqueness before insert
    const existing = await this.findBySku(data.sku);
    if (existing) {
      const err = new Error('SKU already exists');
      err.code  = 'SKU_CONFLICT';
      throw err;
    }

    const now     = new Date().toISOString();
    const product = {
      productId:     uuidv4(),
      name:          data.name,
      description:   data.description,
      price:         Number(data.price),
      comparePrice:  data.comparePrice ? Number(data.comparePrice) : null,
      category:      data.category,
      franchise:     data.franchise,
      franchiseType: data.franchiseType,
      tags:          data.tags    || [],
      images:        data.images  || [],
      sku:           data.sku,
      stock:         Number(data.stock ?? 0),
      sizes:         data.sizes   || [],
      colors:        data.colors  || [],
      rating:        { average: 0, count: 0 },
      isActive:      true,
      createdAt:     now,
      updatedAt:     now,
    };

    await getDocClient().send(
      new PutCommand({
        TableName:           TABLE(),
        Item:                product,
        ConditionExpression: 'attribute_not_exists(productId)',
      })
    );

    return product;
  },

  // ── Update product fields ───────────────────────────────────────────────────
  async update(productId, data) {
    const allowed = [
      'name', 'description', 'price', 'comparePrice', 'category',
      'franchise', 'franchiseType', 'tags', 'images', 'stock',
      'sizes', 'colors', 'rating', 'isActive',
    ];

    const sets   = ['updatedAt = :updatedAt'];
    const values = { ':updatedAt': new Date().toISOString() };
    const names  = {};

    allowed.forEach((field) => {
      if (data[field] !== undefined) {
        // Use expression attribute names to avoid reserved word conflicts
        sets.push(`#${field} = :${field}`);
        names[`#${field}`]  = field;
        values[`:${field}`] = data[field];
      }
    });

    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { productId },
        UpdateExpression:          `SET ${sets.join(', ')}`,
        ExpressionAttributeNames:  names,
        ExpressionAttributeValues: values,
        ConditionExpression:       'attribute_exists(productId)',
        ReturnValues:              'ALL_NEW',
      })
    );

    return result.Attributes;
  },

  // ── Soft-delete (set isActive = false) ─────────────────────────────────────
  async softDelete(productId) {
    const result = await getDocClient().send(
      new UpdateCommand({
        TableName:                 TABLE(),
        Key:                       { productId },
        UpdateExpression:          'SET isActive = :inactive, updatedAt = :now',
        ExpressionAttributeValues: {
          ':inactive': false,
          ':now':      new Date().toISOString(),
        },
        ConditionExpression: 'attribute_exists(productId)',
        ReturnValues:        'ALL_NEW',
      })
    );
    return result.Attributes;
  },
};

module.exports = ProductRepository;
