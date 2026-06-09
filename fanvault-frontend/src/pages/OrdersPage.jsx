import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Package, Clock, CheckCircle, Truck, X, ChevronRight } from 'lucide-react';
import { orderAPI } from '../api/client';
import './OrdersPage.css';

const STATUS_ICONS = {
  placed: <Clock size={16} />,
  confirmed: <CheckCircle size={16} />,
  processing: <Package size={16} />,
  shipped: <Truck size={16} />,
  delivered: <CheckCircle size={16} />,
  cancelled: <X size={16} />,
};

const STATUS_COLORS = {
  placed: 'badge-amber',
  confirmed: 'badge-blue',
  processing: 'badge-blue',
  shipped: 'badge-blue',
  delivered: 'badge-green',
  cancelled: 'badge-red',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({});

  useEffect(() => {
    orderAPI.getMyOrders({ page, limit: 10 })
      .then(({ data }) => {
        setOrders(Array.isArray(data?.orders) ? data.orders : []);
        setPagination(data?.pagination || {});
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page]);

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="page">
      <div className="container">
        <div className="page-header">
          <h1>My Orders</h1>
          <p>{pagination.total || 0} order{(pagination.total || 0) !== 1 ? 's' : ''}</p>
        </div>

        {orders.length === 0 ? (
          <div className="empty-state">
            <Package size={64} />
            <h3>No orders yet</h3>
            <p>Your orders will appear here once you make a purchase.</p>
            <Link to="/products" className="btn btn-primary">Start Shopping</Link>
          </div>
        ) : (
          <div className="orders-list">
            {orders.map((order) => (
              <Link key={order._id || order.orderId} to={`/orders/${order._id || order.orderId}`} className="order-card card">
                <div className="order-card-header">
                  <div className="order-number">
                    <span className="order-label">Order</span>
                    <span className="order-num">#{order.orderNumber}</span>
                  </div>
                  <span className={`badge ${STATUS_COLORS[order.status]}`}>
                    {STATUS_ICONS[order.status]} {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                  </span>
                </div>
                <div className="order-card-body">
                  <div className="order-items-preview">
                    {(order.items || []).slice(0, 3).map((item, i) => (
                      <div key={i} className="order-item-thumb">
                        <img src={item.image || 'https://placehold.co/60x60/f4fdf6/2d6a4f?text=Item'} alt={item.name} />
                      </div>
                    ))}
                    {order.items.length > 3 && (
                      <div className="order-item-more">+{order.items.length - 3}</div>
                    )}
                  </div>
                  <div className="order-meta">
                    <p className="order-items-count">{order.items.length} item{order.items.length > 1 ? 's' : ''}</p>
                    <p className="order-date">{new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  </div>
                  <div className="order-total">
                    <span className="order-total-amount">₹{order.total?.toLocaleString('en-IN')}</span>
                    <ChevronRight size={16} className="order-chevron" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {pagination.pages > 1 && (
          <div className="pagination">
            <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="pagination-info">Page {page} of {pagination.pages}</span>
            <button className="btn btn-ghost btn-sm" disabled={page >= pagination.pages} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
