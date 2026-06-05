const express = require('express');
const { body } = require('express-validator');
const { authenticate, adminOnly } = require('../middleware/auth.middleware');
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductsBulk,
  getProductImage,
} = require('../controllers/product.controller');

const router = express.Router();

const productValidation = [
  body('name').notEmpty().withMessage('Product name is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('price').isFloat({ min: 0 }).withMessage('Valid price required'),
  body('category')
    .isIn(['clothing', 'accessories', 'shoes', 'ornaments'])
    .withMessage('Invalid category'),
  body('franchise').notEmpty().withMessage('Franchise is required'),
  body('franchiseType')
    .isIn(['sports', 'movie', 'show'])
    .withMessage('Invalid franchise type'),
  body('sku').notEmpty().withMessage('SKU is required'),
  body('stock').isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),
];

// ── Public routes ─────────────────────────────────────────────────────────────
router.get('/',      getProducts);
router.get('/bulk',  getProductsBulk);
router.get('/images/:key', getProductImage);
router.get('/:id',   getProduct);

// ── Admin-only routes ─────────────────────────────────────────────────────────
router.post('/',     authenticate, adminOnly, productValidation, createProduct);
router.patch('/:id', authenticate, adminOnly, updateProduct);
router.delete('/:id',authenticate, adminOnly, deleteProduct);

module.exports = router;
