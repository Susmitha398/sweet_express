const express = require('express');
const router = express.Router();
const {
  createOrder,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getOrderById,
  getCustomerOrders
} = require('../controllers/orderController');

router.post('/orders', createOrder);
router.post('/payments/razorpay/order', createRazorpayOrder);
router.post('/payments/razorpay/verify', verifyRazorpayPayment);
router.get('/orders/:orderId', getOrderById);
router.get('/orders', getCustomerOrders);

module.exports = router;
