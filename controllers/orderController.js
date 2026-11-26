const Order = require('../models/Order');
const Sweet = require('../models/Sweet');
const { getDbStatus } = require('../config/db');
const crypto = require('crypto');

let memoryOrders = [];

const requireRazorpay = () => {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error('Razorpay is not configured. Add API keys to the backend environment.');
  return { keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET };
};

const createRazorpayOrder = async (req, res) => {
  try {
    if (!getDbStatus()) return res.status(503).json({ success: false, message: 'Online payments require the order database to be connected.' });
    const { keyId, keySecret } = requireRazorpay();
    const { customer, items, promoCode } = req.body;
    if (!customer?.name || !customer?.phone || !customer?.email || !customer?.address || !customer?.city || !customer?.pincode || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'Please provide complete delivery details and cart items.' });
    }

    const ids = items.map(item => item.sweetId);
    const testProductEnabled = process.env.ENABLE_RAZORPAY_TEST_PRODUCT !== 'false';
    const testItems = items.filter(item => item.sweetId === 'razorpay-test-item');
    if (testItems.length && (!testProductEnabled || items.length !== 1 || Number(testItems[0].quantity) !== 1 || testItems[0].weight !== '1 pc')) {
      return res.status(400).json({ success: false, message: 'The ₹1 payment test item must be ordered by itself, once per checkout.' });
    }
    const regularIds = ids.filter(id => id !== 'razorpay-test-item');
    const sweets = regularIds.length ? await Sweet.find({ _id: { $in: regularIds }, inStock: true }).lean() : [];
    const byId = new Map(sweets.map(sweet => [String(sweet._id), sweet]));
    const pricedItems = items.map(item => {
      if (item.sweetId === 'razorpay-test-item' && testProductEnabled && item.weight === '1 pc' && Number(item.quantity) === 1) {
        return { sweetId: 'razorpay-test-item', name: 'Razorpay Payment Test Item (₹1)', category: 'Payment Test', weight: '1 pc', quantity: 1, unitPrice: 1, itemTotal: 1, shopLocation: 'Online Payment Test' };
      }
      const sweet = byId.get(String(item.sweetId));
      const option = sweet?.weightOptions?.find(opt => opt.weight === item.weight);
      const quantity = Number(item.quantity);
      if (!sweet || !option || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new Error('One or more cart items are unavailable. Please refresh your cart.');
      const unitPrice = Math.round(sweet.pricePerKg * option.multiplier);
      return { sweetId: String(sweet._id), name: sweet.name, category: sweet.category, weight: item.weight, quantity, unitPrice, itemTotal: unitPrice * quantity, image: sweet.image, shopLocation: sweet.shopLocation };
    });
    const subtotal = pricedItems.reduce((sum, item) => sum + item.itemTotal, 0);
    const deliveryFee = testItems.length || subtotal === 0 || subtotal >= 500 ? 0 : 40;
    const normalizedPromo = String(promoCode || '').trim().toUpperCase();
    const discountPercent = ['SWEET10', 'ROYAL10'].includes(normalizedPromo) ? 10 : ['SWEET20', 'FESTIVE20'].includes(normalizedPromo) ? 20 : 0;
    const discount = Math.round(subtotal * discountPercent / 100);
    const totalAmount = Math.max(0, subtotal - discount + deliveryFee);
    if (!Number.isSafeInteger(totalAmount) || totalAmount < 1) return res.status(400).json({ success: false, message: 'Order total must be at least ₹1.' });

    const orderId = `ROYAL-${crypto.randomUUID()}`;
    const order = await Order.create({ orderId, customer, items: pricedItems, subtotal, deliveryFee, discount, totalAmount, paymentMethod: 'razorpay', paymentStatus: 'Payment Pending', orderStatus: 'Awaiting Payment' });
    const rpResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
      body: JSON.stringify({ amount: totalAmount * 100, currency: 'INR', receipt: orderId, notes: { shopOrderId: orderId } })
    });
    const rpData = await rpResponse.json();
    if (!rpResponse.ok) {
      await Order.deleteOne({ _id: order._id });
      console.error('[Razorpay order error]', rpData.error?.description || rpResponse.status);
      return res.status(502).json({ success: false, message: 'Could not start Razorpay checkout. Please try again.' });
    }
    order.razorpayOrderId = rpData.id;
    await order.save();
    return res.status(201).json({ success: true, data: { keyId, razorpayOrderId: rpData.id, orderId, amount: rpData.amount, currency: rpData.currency, customer: order.customer, totalAmount } });
  } catch (error) {
    const status = error.message.includes('not configured') ? 503 : error.message.includes('unavailable') ? 400 : 500;
    return res.status(status).json({ success: false, message: status === 500 ? 'Unable to create payment order.' : error.message });
  }
};

const verifyRazorpayPayment = async (req, res) => {
  try {
    const { keySecret } = requireRazorpay();
    const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const order = await Order.findOne({ orderId, razorpayOrderId: razorpay_order_id });
    if (!order) return res.status(404).json({ success: false, message: 'Payment order not found.' });
    const expected = crypto.createHmac('sha256', keySecret).update(`${order.razorpayOrderId}|${razorpay_payment_id}`).digest();
    const received = Buffer.from(String(razorpay_signature || ''), 'hex');
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) return res.status(400).json({ success: false, message: 'Payment signature verification failed.' });
    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${keySecret}`).toString('base64')}` }
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || payment.order_id !== order.razorpayOrderId || payment.amount !== order.totalAmount * 100 || payment.currency !== 'INR' || payment.status !== 'captured') {
      return res.status(400).json({ success: false, message: 'Payment is not captured yet. If money was debited, contact the shop with your payment ID.' });
    }
    if (order.paymentStatus !== 'Paid') {
      order.paymentStatus = 'Paid';
      order.orderStatus = order.items.some(item => item.sweetId === 'razorpay-test-item')
        ? 'Payment Test Complete (No Delivery)'
        : 'Confirmed & Being Freshly Packed';
      order.razorpayPaymentId = razorpay_payment_id;
      await order.save();
    }
    return res.json({ success: true, data: order });
  } catch (error) {
    const status = error.message.includes('not configured') ? 503 : 500;
    return res.status(status).json({ success: false, message: status === 500 ? 'Unable to verify payment.' : error.message });
  }
};

// Create a new order
const createOrder = async (req, res) => {
  try {
    const { customer, items, subtotal, deliveryFee, discount, totalAmount, paymentMethod } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart items cannot be empty' });
    }

    if (!customer || !customer.name || !customer.phone || !customer.email || !customer.address || !customer.city || !customer.pincode) {
      return res.status(400).json({ success: false, message: 'Please provide complete delivery details' });
    }

    const selectedPaymentMethod = paymentMethod || 'cod';
    const allowedPaymentMethods = ['cod'];
    if (!allowedPaymentMethods.includes(selectedPaymentMethod)) {
      return res.status(400).json({ success: false, message: 'Please choose a supported payment method' });
    }

    const orderId = 'ROYAL-' + Math.floor(100000 + Math.random() * 900000);

    const orderData = {
      orderId,
      customer,
      items,
      subtotal: Number(subtotal) || 0,
      deliveryFee: Number(deliveryFee) || 0,
      discount: Number(discount) || 0,
      totalAmount: Number(totalAmount) || 0,
      paymentMethod: selectedPaymentMethod,
      // This project has no payment gateway integration, so online payments must
      // never be represented as completed or verified.
      paymentStatus: selectedPaymentMethod === 'cod'
        ? 'Pending (Cash On Delivery)'
        : 'Pending (Online Payment Verification Required)',
      orderStatus: 'Confirmed & Being Freshly Packed',
      estimatedDeliveryTime: '30 - 45 Minutes',
      createdAt: new Date()
    };

    if (getDbStatus()) {
      try {
        const newOrder = new Order(orderData);
        await newOrder.save();
      } catch (dbErr) {
        console.warn('[Order DB Error]', dbErr.message);
      }
    }

    memoryOrders.unshift(orderData);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully! Sweets are being freshly packed with pure desi ghee.',
      data: orderData
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get order by Order ID
const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    let order = null;

    if (getDbStatus()) {
      order = await Order.findOne({ orderId }).lean();
    }
    if (!order) {
      order = memoryOrders.find(o => o.orderId === orderId);
    }

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Get orders by customer email or phone
const getCustomerOrders = async (req, res) => {
  try {
    const { phone, email } = req.query;
    let orders = [];

    if (getDbStatus()) {
      let filter = {};
      if (phone) filter['customer.phone'] = phone;
      if (email) filter['customer.email'] = email;
      orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    }
    if (orders.length === 0) {
      orders = memoryOrders.filter(o => 
        (phone && o.customer?.phone === phone) || 
        (email && o.customer?.email?.toLowerCase() === email.toLowerCase())
      );
    }

    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createOrder,
  createRazorpayOrder,
  verifyRazorpayPayment,
  getOrderById,
  getCustomerOrders
};
