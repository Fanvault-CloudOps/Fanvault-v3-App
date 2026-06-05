const { validationResult } = require('express-validator');
const Product = require('../models/Product');
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });

// ── GET /api/products ────────────────────────────────────────────────────────
exports.getProducts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      category,
      franchise,
      franchiseType,
      search,
      minPrice,
      maxPrice,
    } = req.query;

    const query = { isActive: true };
    if (category)     query.category     = category;
    if (franchise)    query.franchise     = new RegExp(franchise, 'i');
    if (franchiseType) query.franchiseType = franchiseType;
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    let dbQuery;
    if (search) {
      // Use MongoDB text index for full-text search
      dbQuery = Product.find({ ...query, $text: { $search: search } }, {
        score: { $meta: 'textScore' },
      }).sort({ score: { $meta: 'textScore' } });
    } else {
      dbQuery = Product.find(query).sort({ createdAt: -1 });
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [products, total] = await Promise.all([
      dbQuery.skip(skip).limit(Number(limit)),
      Product.countDocuments(query),
    ]);

    res.json({
      products,
      pagination: {
        total,
        page:  Number(page),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error('[product] getProducts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/bulk — batch fetch by array of IDs ─────────────────────
exports.getProductsBulk = async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ error: 'ids query parameter required' });

    const idList = ids.split(',').map((id) => id.trim());
    const products = await Product.find({ _id: { $in: idList }, isActive: true });
    res.json({ products });
  } catch (err) {
    console.error('[product] getProductsBulk error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/:id ────────────────────────────────────────────────────
exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, isActive: true });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ product });
  } catch (err) {
    console.error('[product] getProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /api/products — admin only ─────────────────────────────────────────
exports.createProduct = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const product = await Product.create(req.body);
    res.status(201).json({ message: 'Product created', product });
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: 'SKU already exists' });
    console.error('[product] createProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/products/:id — admin only ─────────────────────────────────────
exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product updated', product });
  } catch (err) {
    console.error('[product] updateProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/products/:id — admin only (soft-delete) ──────────────────────
exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deactivated', product });
  } catch (err) {
    console.error('[product] deleteProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper to retrieve and cache S3 Bucket Name and Region from SSM Parameter Store
let cachedBucketName = null;
let cachedBucketRegion = null;

async function getS3Config() {
  if (cachedBucketName && cachedBucketRegion) {
    return { bucket: cachedBucketName, region: cachedBucketRegion };
  }

  try {
    console.log('[image] Fetching S3 configuration from SSM Parameter Store...');
    const bucketResponse = await ssm.send(
      new GetParameterCommand({ Name: process.env.SSM_S3_BUCKET_PATH || "/fanvault/s3/bucket" })
    );
    cachedBucketName = bucketResponse.Parameter.Value;

    try {
      const regionResponse = await ssm.send(
        new GetParameterCommand({ Name: process.env.SSM_S3_REGION_PATH || "/fanvault/s3/region" })
      );
      cachedBucketRegion = regionResponse.Parameter.Value;
    } catch (err) {
      console.log('[image] S3 Region parameter not found in SSM, using default: us-east-1');
      cachedBucketRegion = process.env.AWS_REGION || "us-east-1";
    }

    return { bucket: cachedBucketName, region: cachedBucketRegion };
  } catch (error) {
    console.error('[image] Error fetching S3 configuration from SSM:', error.message);
    throw error;
  }
}

// ── GET /api/products/images/:key — fetch and proxy image from S3 ───────────────
exports.getProductImage = async (req, res) => {
  try {
    const key = req.params.key;
    const { bucket, region } = await getS3Config();

    const s3 = new S3Client({ region });
    console.log(`[image] Fetching object '${key}' from S3 bucket '${bucket}'...`);
    const s3Response = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    // Set headers and stream s3 object body to response
    res.setHeader("Content-Type", s3Response.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year
    s3Response.Body.pipe(res);
  } catch (err) {
    console.error('[product] getProductImage error:', err.message);
    if (err.name === 'NoSuchKey' || err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Image not found in S3 bucket' });
    }
    res.status(500).json({ error: 'Failed to retrieve image from S3 storage' });
  }
};
