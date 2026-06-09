const { validationResult } = require('express-validator');
const ProductRepository = require('../models/Product');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const { logAuditEvent } = require('../utils/auditLogger');

const ssm = new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' });

// ── Helpers for S3 key mapping ────────────────────────────────────────────────
function formatProductImageUrls(product, cloudfrontUrl) {
  if (!product) return product;
  const mapped = { ...product };
  
  // Map identifier fields for frontend compatibility (DynamoDB uses productId)
  mapped._id = product.productId;
  mapped.id = product.productId;

  if (Array.isArray(mapped.images)) {
    mapped.images = mapped.images.map((img) => {
      if (!img) return img;
      // If it already starts with http/https, return as is
      if (img.startsWith('http://') || img.startsWith('https://')) {
        return img;
      }
      
      // Extract key from legacy proxy URL if present
      let key = img;
      if (img.startsWith('/api/products/images/')) {
        key = img.replace('/api/products/images/', '');
      }

      // If CloudFront URL is available, return CloudFront URL. Otherwise fall back to local proxy path.
      if (cloudfrontUrl) {
        const cleanUrl = cloudfrontUrl.startsWith('http') ? cloudfrontUrl : `https://${cloudfrontUrl}`;
        const trimmedUrl = cleanUrl.endsWith('/') ? cleanUrl.slice(0, -1) : cleanUrl;
        const cleanKey = key.startsWith('/') ? key.slice(1) : key;
        return `${trimmedUrl}/${cleanKey}`;
      }

      return `/api/products/images/${key}`;
    });
  }
  return mapped;
}

function extractImageKeys(images, cloudfrontUrl) {
  if (!Array.isArray(images)) return images;
  return images.map((img) => {
    if (!img) return img;
    
    // Strip CloudFront URL prefix if it exists
    if (cloudfrontUrl) {
      const cleanUrl = cloudfrontUrl.startsWith('http') ? cloudfrontUrl : `https://${cloudfrontUrl}`;
      const prefixWithSlash = cleanUrl.endsWith('/') ? cleanUrl : `${cleanUrl}/`;
      if (img.startsWith(prefixWithSlash)) {
        return img.replace(prefixWithSlash, '');
      }
      // Also check for raw domain match (without protocol)
      const domain = cloudfrontUrl.replace(/^https?:\/\//, '');
      const domainWithSlash = domain.endsWith('/') ? domain : `${domain}/`;
      if (img.includes(domainWithSlash)) {
        const parts = img.split(domainWithSlash);
        return parts[parts.length - 1];
      }
    }

    // Strip legacy API proxy prefix
    if (img.startsWith('/api/products/images/')) {
      return img.replace('/api/products/images/', '');
    }
    return img;
  });
}

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

    const { cloudfrontUrl } = await getS3Config();

    res.json({
      products: products.map((p) => formatProductImageUrls(p, cloudfrontUrl)),
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
    const { cloudfrontUrl } = await getS3Config();

    res.json({ products: products.map((p) => formatProductImageUrls(p, cloudfrontUrl)) });
  } catch (err) {
    console.error('[product] getProductsBulk error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/:productId ──────────────────────────────────────────────
exports.getProduct = async (req, res) => {
  try {
    const product = await ProductRepository.findById(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const { cloudfrontUrl } = await getS3Config();
    res.json({ product: formatProductImageUrls(product, cloudfrontUrl) });
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

    const { cloudfrontUrl } = await getS3Config();

    // Store only S3 keys in DB
    if (req.body.images) {
      req.body.images = extractImageKeys(req.body.images, cloudfrontUrl);
    }

    const product = await ProductRepository.create(req.body);
    logAuditEvent({ adminId: req.user.id, adminEmail: req.user.email, action: 'PRODUCT_CREATED', entityType: 'product', entityId: product.productId, changes: { name: product.name, sku: product.sku } });
    res.status(201).json({ message: 'Product created', product: formatProductImageUrls(product, cloudfrontUrl) });
  } catch (err) {
    if (err.code === 'SKU_CONFLICT')
      return res.status(409).json({ error: 'SKU already exists' });
    console.error('[product] createProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── PATCH /api/products/:productId — admin only ──────────────────────────────
exports.updateProduct = async (req, res) => {
  try {
    const { cloudfrontUrl } = await getS3Config();

    // Store only S3 keys in DB
    if (req.body.images) {
      req.body.images = extractImageKeys(req.body.images, cloudfrontUrl);
    }

    const product = await ProductRepository.update(req.params.productId, req.body);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    logAuditEvent({ adminId: req.user.id, adminEmail: req.user.email, action: 'PRODUCT_UPDATED', entityType: 'product', entityId: req.params.productId, changes: req.body });
    res.json({ message: 'Product updated', product: formatProductImageUrls(product, cloudfrontUrl) });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Product not found' });
    console.error('[product] updateProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── DELETE /api/products/:productId — admin only (soft-delete) ───────────────
exports.deleteProduct = async (req, res) => {
  try {
    const product = await ProductRepository.softDelete(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    logAuditEvent({ adminId: req.user.id, adminEmail: req.user.email, action: 'PRODUCT_DELETED', entityType: 'product', entityId: req.params.productId });
    const { cloudfrontUrl } = await getS3Config();
    res.json({ message: 'Product deactivated', product: formatProductImageUrls(product, cloudfrontUrl) });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'Product not found' });
    console.error('[product] deleteProduct error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── GET /api/products/upload-url — admin only (presigned URL) ─────────────────
exports.getUploadUrl = async (req, res) => {
  try {
    const { fileType, fileSize, folder } = req.query;

    if (!fileType || !fileSize || !folder) {
      return res.status(400).json({ error: 'fileType, fileSize, and folder query parameters are required' });
    }

    // 1. Validate file type (Allowed image mime types)
    const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!ALLOWED_TYPES.includes(fileType.toLowerCase())) {
      return res.status(400).json({ error: `Invalid file type. Allowed types: ${ALLOWED_TYPES.join(', ')}` });
    }

    // 2. Validate file size (max 5MB)
    const size = Number(fileSize);
    const MAX_SIZE = 5 * 1024 * 1024;
    if (isNaN(size) || size <= 0 || size > MAX_SIZE) {
      return res.status(400).json({ error: `Invalid file size. Must be greater than 0 and less than or equal to 5MB (5242880 bytes).` });
    }

    // 3. Validate folder structure
    const ALLOWED_FOLDERS = ['products', 'categories', 'thumbnails'];
    if (!ALLOWED_FOLDERS.includes(folder.toLowerCase())) {
      return res.status(400).json({ error: `Invalid folder. Allowed folders: ${ALLOWED_FOLDERS.join(', ')}` });
    }

    // 4. Determine extension and S3 key
    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif'
    };
    const ext = mimeToExt[fileType.toLowerCase()] || 'jpg';
    const key = `${folder.toLowerCase()}/${uuidv4()}.${ext}`;

    // 5. Get S3 configuration and generate presigned URL for PUT
    const { bucket, region } = await getS3Config();
    const s3 = new S3Client({ region });
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // Valid for 15 minutes

    logAuditEvent({ adminId: req.user.id, adminEmail: req.user.email, action: 'IMAGE_UPLOAD_URL_GENERATED', entityType: 'product', entityId: key });
    res.json({
      uploadUrl,
      key,
    });
  } catch (err) {
    console.error('[product] getUploadUrl error:', err.message);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
};

// ── S3 image proxy (SSM + S3 SDK v3) ──────────────────────────────────────────
let cachedBucketName   = null;
let cachedBucketRegion = null;
let cachedCloudFrontUrl = null;

async function getS3Config() {
  if (cachedBucketName && cachedBucketRegion && cachedCloudFrontUrl !== null) {
    return { bucket: cachedBucketName, region: cachedBucketRegion, cloudfrontUrl: cachedCloudFrontUrl };
  }
  console.log('[image] Fetching S3 & CloudFront config from SSM Parameter Store...');
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

  try {
    const cfRes = await ssm.send(
      new GetParameterCommand({ Name: process.env.SSM_CLOUDFRONT_URL_PATH || '/fanvault/s3/cloudfront_url' })
    );
    cachedCloudFrontUrl = cfRes.Parameter.Value;
  } catch (err) {
    console.warn('[image] CloudFront URL not found in Parameter Store:', err.message);
    cachedCloudFrontUrl = '';
  }

  return { bucket: cachedBucketName, region: cachedBucketRegion, cloudfrontUrl: cachedCloudFrontUrl };
}

// ── GET /api/products/images/:key — proxy image from private S3 ──────────────
exports.getProductImage = async (req, res) => {
  try {
    const key              = req.params.key || req.params[0];
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


