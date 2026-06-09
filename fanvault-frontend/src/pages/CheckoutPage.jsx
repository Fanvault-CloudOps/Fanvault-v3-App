import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, ArrowLeft, Package } from 'lucide-react';
import { orderAPI } from '../api/client';
import { useCart } from '../context/CartContext';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import './CheckoutPage.css';

const PAYMENT_METHODS = [
  { value: 'cod', label: '💵 Cash on Delivery' },
  { value: 'upi', label: '📱 UPI' },
  { value: 'card', label: '💳 Credit / Debit Card' },
  { value: 'netbanking', label: '🏦 Net Banking' },
];

export default function CheckoutPage() {
  const navigate = useNavigate();
  const { items, total, clearCart } = useCart();
  const { user, profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [orderPlaced, setOrderPlaced] = useState(null);

  const shipping = total >= 1999 ? 0 : 99;
  const tax = Math.round(total * 0.18);
  const grandTotal = total + shipping + tax;

  const defaultAddress = profile?.addresses?.find((a) => a.isDefault) || profile?.addresses?.[0];

  const [addr, setAddr] = useState({
    line1: defaultAddress?.line1 || '',
    line2: defaultAddress?.line2 || '',
    city: defaultAddress?.city || '',
    state: defaultAddress?.state || '',
    postalCode: defaultAddress?.postalCode || '',
    country: defaultAddress?.country || 'India',
  });

  if (items.length === 0 && !orderPlaced) {
    navigate('/cart');
    return null;
  }

  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    if (!addr.line1 || !addr.city || !addr.state || !addr.postalCode) {
      toast.error('Please fill in all required address fields');
      return;
    }
    setLoading(true);
    try {
      const { data } = await orderAPI.createOrder({
        items: items.map((i) => ({
          productId: i.productId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
          image: i.image,
          size: i.size,
          color: i.color,
        })),
        shippingAddress: addr,
        paymentMethod,
        userEmail: user.email,
      });
      clearCart();
      setOrderPlaced(data.order);
      toast.success('🎉 Order placed successfully!');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to place order');
    } finally {
      setLoading(false);
    }
  };

  if (orderPlaced) {
    return (
      <div className="page">
        <div className="container">
          <div className="order-success">
            <div className="success-icon"><CheckCircle size={64} /></div>
            <h2>Order Placed Successfully!</h2>
            <p>Your order <strong>#{orderPlaced.orderNumber}</strong> has been confirmed.</p>
            <p className="success-email">A confirmation email has been sent to <strong>{user.email}</strong></p>
            <div className="success-total">Total: ₹{orderPlaced.total?.toLocaleString('en-IN')}</div>
            <div className="success-actions">
              <button className="btn btn-primary btn-lg" onClick={() => navigate(`/orders/${orderPlaced._id || orderPlaced.orderId}`)}>
                <Package size={18} /> View Order
              </button>
              <button className="btn btn-secondary btn-lg" onClick={() => navigate('/products')}>
                Continue Shopping
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="container">
        <div className="page-header">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/cart')}>
            <ArrowLeft size={15} /> Back to Cart
          </button>
          <h1>Checkout</h1>
        </div>

        <form className="checkout-layout" onSubmit={handlePlaceOrder}>
          {/* Left column */}
          <div className="checkout-main">
            {/* Shipping */}
            <div className="card card-body checkout-section">
              <h3>Shipping Address</h3>
              <div className="form-grid">
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Address Line 1 *</label>
                  <input className="form-input" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} placeholder="Street address, apartment, etc." required />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label className="form-label">Address Line 2</label>
                  <input className="form-input" value={addr.line2} onChange={(e) => setAddr({ ...addr, line2: e.target.value })} placeholder="Landmark (optional)" />
                </div>
                <div className="form-group">
                  <label className="form-label">City *</label>
                  <input className="form-input" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">State *</label>
                  <input className="form-input" value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">PIN Code *</label>
                  <input className="form-input" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Country</label>
                  <input className="form-input" value={addr.country} onChange={(e) => setAddr({ ...addr, country: e.target.value })} />
                </div>
              </div>
            </div>

            {/* Payment */}
            <div className="card card-body checkout-section">
              <h3>Payment Method</h3>
              <div className="payment-methods">
                {PAYMENT_METHODS.map((pm) => (
                  <label key={pm.value} className={`payment-option ${paymentMethod === pm.value ? 'selected' : ''}`}>
                    <input type="radio" name="payment" value={pm.value} checked={paymentMethod === pm.value} onChange={() => setPaymentMethod(pm.value)} />
                    <span>{pm.label}</span>
                  </label>
                ))}
              </div>
              {paymentMethod !== 'cod' && (
                <div className="payment-note">
                  💡 Online payment integration coming soon. For now this simulates the order placement.
                </div>
              )}
            </div>
          </div>

          {/* Right: Summary */}
          <div className="checkout-summary">
            <div className="card card-body">
              <h3>Order Summary</h3>
              <div className="checkout-items">
                {items.map((item) => (
                  <div key={`${item.productId}-${item.size}-${item.color}`} className="checkout-item">
                    <div className="checkout-item-img">
                      <img src={item.image || 'https://placehold.co/60x60/f4fdf6/2d6a4f?text=Item'} alt={item.name} />
                      <span className="checkout-qty">{item.quantity}</span>
                    </div>
                    <div className="checkout-item-info">
                      <p className="checkout-item-name">{item.name}</p>
                      {item.size && <span className="checkout-item-variant">Size: {item.size}</span>}
                    </div>
                    <span className="checkout-item-price">₹{(item.price * item.quantity).toLocaleString('en-IN')}</span>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="summary-rows">
                <div className="summary-row"><span>Subtotal</span><span>₹{total.toLocaleString('en-IN')}</span></div>
                <div className="summary-row"><span>Shipping</span><span className={shipping === 0 ? 'free-shipping' : ''}>{shipping === 0 ? 'FREE' : `₹${shipping}`}</span></div>
                <div className="summary-row"><span>Tax (18% GST)</span><span>₹{tax.toLocaleString('en-IN')}</span></div>
                <div className="divider" />
                <div className="summary-row total-row"><span>Total</span><span>₹{grandTotal.toLocaleString('en-IN')}</span></div>
              </div>
              <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading} style={{ marginTop: 20 }}>
                {loading ? <><div className="spinner spinner-sm" />Placing Order...</> : `Place Order – ₹${grandTotal.toLocaleString('en-IN')}`}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
