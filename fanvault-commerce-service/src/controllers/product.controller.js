const { validationResult } = require('express-validator');
const Product = require('../models/Product');

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
