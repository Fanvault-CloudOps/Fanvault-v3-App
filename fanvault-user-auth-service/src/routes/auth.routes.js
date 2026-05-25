const express = require('express');
const { body } = require('express-validator');
const {
  register,
  login,
  refresh,
  verify,
  logout,
} = require('../controllers/auth.controller');

const router = express.Router();

const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];

router.post('/register', registerValidation, register);
router.post('/login', loginValidation, login);
router.post('/refresh', refresh);
router.get('/verify', verify);
router.post('/logout', logout);

module.exports = router;
