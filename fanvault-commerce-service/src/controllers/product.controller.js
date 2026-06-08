const { validationResult } = require('express-validator');
const ProductRepository = require('../models/Product');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { S3Client, GetObjectCommand }     = require('@aws-sdk/client-s3');

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

// ── GET /api/products ─────────────────────────────────────────────────────────
exports.getProducts = async (req, res) => {
  try {
    const {
      page,
      limit = 20,
      category,
      franchise,
      franchiseType,
      search,
      minPrice,
      maxPrice,
      lastKey: rawKey,
    } = req.query;

    // DynamoDB uses a cursor (LastEvaluatedKey) rather than page numbers.
    // Accept a base64-encoded cursor from the client for pagination.
    let lastKey;
    try {
      lastKey = rawKey ? JSON.parse(Buffer.from(rawKey, 'base64').toString()) : undefined;
    } catch {
      lastKey = undefined;
    }

    const { products, lastKey: nextKey, hasMore } = await ProductRepository.list({
      category,
      franchise,
      franchiseType,
      search,
      minPrice,
      maxPrice,
      limit: Number(limit),
      lastKey,
    });

    res.json({
      products,
      pagination: {
        count:   products.length,
        hasMore,
        // Return opaque base64 cursor — client passes this back as ?lastKey=
        nextKey: nextKey ? Buffer.from(JSON.stringify(nextKey)).toString('base64') : null,
      },
    });
  } catch (err) {
    console.error('[product] getProducts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/bulk — batch fetch by comma-separated IDs ───────────────
exports.getProductsBulk = async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ error: 'ids query parameter required' });

    const idList   = ids.split(',').map((id) => id.trim());
    const products = await ProductRepository.bulkFindByIds(idList);
    res.json({ products });
  } catch (err) {
    console.error('[product] getProductsBulk error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/:id ─────────────────────────────────────────────────────
exports.getProduct = async (req, res) => {
  try {
    const product = await ProductRepository.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) {
    console.error('[product] getProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/products — admin only ──────────────────────────────────────────
exports.createProduct = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const product = await ProductRepository.create(req.body);
    res.status(201).json({ message: 'Product created', product });
  } catch (err) {
    if (err.code === 'SKU_CONFLICT')
      return res.status(409).json({ error: 'SKU already exists' });
    console.error('[product] createProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/products/:id — admin only ─────────────────────────────────────
exports.updateProduct = async (req, res) => {
  try {
    const product = await ProductRepository.update(req.params.id, req.body);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product updated', product });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Product not found' });
    console.error('[product] updateProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/products/:id — admin only (soft-delete) ──────────────────────
exports.deleteProduct = async (req, res) => {
  try {
    const product = await ProductRepository.softDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deactivated', product });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Product not found' });
    console.error('[product] deleteProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── S3 image proxy (unchanged — SSM + S3 SDK v3) ─────────────────────────────
let cachedBucketName   = null;
let cachedBucketRegion = null;

async function getS3Config() {
  if (cachedBucketName && cachedBucketRegion) {
    return { bucket: cachedBucketName, region: cachedBucketRegion };
  }
  console.log('[image] Fetching S3 config from SSM Parameter Store...');
  const bucketRes = await ssm.send(
    new GetParameterCommand({ Name: process.env.SSM_S3_BUCKET_PATH || '/fanvault/s3/bucket' })
  );
  cachedBucketName = bucketRes.Parameter.Value;

  try {
    const regionRes = await ssm.send(
      new GetParameterCommand({ Name: process.env.SSM_S3_REGION_PATH || '/fanvault/s3/region' })
    );
    cachedBucketRegion = regionRes.Parameter.Value;
  } catch {
    cachedBucketRegion = process.env.AWS_REGION || 'us-east-1';
  }

  return { bucket: cachedBucketName, region: cachedBucketRegion };
}

// ── GET /api/products/images/:key — proxy image from private S3 ──────────────
exports.getProductImage = async (req, res) => {
  try {
    const key              = req.params.key;
    const { bucket, region } = await getS3Config();

    const s3       = new S3Client({ region });
    const s3Resp   = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    res.setHeader('Content-Type',  s3Resp.ContentType  || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    s3Resp.Body.pipe(res);
  } catch (err) {
    console.error('[product] getProductImage error:', err.message);
    if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey')
      return res.status(404).json({ error: 'Image not found in S3 bucket' });
    res.status(500).json({ error: 'Failed to retrieve image from S3 storage' });
  }
};
