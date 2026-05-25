const express = require('express');
const { body } = require('express-validator');
const { authenticate, adminOnly } = require('../middleware/auth.middleware');
const {
  createOrder,
  getMyOrders,
  getOrder,
  updateOrderStatus,
  getAllOrders,
  cancelOrder,
} = require('../controllers/order.controller');

const router = express.Router();

const orderItemValidation = [
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').notEmpty().withMessage('Product ID required'),
  body('items.*.name').notEmpty().withMessage('Product name required'),
  body('items.*.price').isFloat({ min: 0 }).withMessage('Valid price required'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('shippingAddress.line1').notEmpty().withMessage('Address line 1 required'),
  body('shippingAddress.city').notEmpty().withMessage('City required'),
  body('shippingAddress.state').notEmpty().withMessage('State required'),
  body('shippingAddress.postalCode').notEmpty().withMessage('Postal code required'),
  body('shippingAddress.country').notEmpty().withMessage('Country required'),
];

// All order routes require authentication
router.use(authenticate);

router.post('/',             orderItemValidation, createOrder);
router.get('/my',            getMyOrders);
router.get('/',              adminOnly, getAllOrders);
router.get('/:id',           getOrder);
router.patch('/:id/status',  adminOnly, updateOrderStatus);
router.post('/:id/cancel',   cancelOrder);

module.exports = router;
