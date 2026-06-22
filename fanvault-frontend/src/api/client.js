import axios from 'axios';

// All API calls go through Nginx which proxies to individual services
const BASE = '';

export const api = axios.create({
  baseURL: BASE,
  timeout: 10000,
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh token on 401
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) throw new Error('No refresh token');
        const { data } = await axios.post('/api/auth/refresh', { refreshToken });
        localStorage.setItem('accessToken', data.accessToken);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch {
        localStorage.clear();
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────
export const authAPI = {
  register:   (data) => api.post('/api/auth/register', data),
  confirm:    (data) => api.post('/api/auth/confirm', data),
  resendCode: (data) => api.post('/api/auth/resend-code', data),
  login:      (data) => api.post('/api/auth/login', data),
  logout:     ()     => api.post('/api/auth/logout'),
  verify:     ()     => api.get('/api/auth/verify'),
};

// ── Users ─────────────────────────────────────────
export const userAPI = {
  getProfile: () => api.get('/api/users/me'),
  createProfile: (data) => api.post('/api/users/me', data),
  updateProfile: (data) => api.patch('/api/users/me', data),
  addAddress: (data) => api.post('/api/users/me/addresses', data),
  removeAddress: (id) => api.delete(`/api/users/me/addresses/${id}`),
};

// ── Products ──────────────────────────────────────
export const productAPI = {
  getProducts: (params) => api.get('/api/products', { params }),
  getProduct: (productId) => api.get(`/api/products/${productId}`),
  createProduct: (data) => api.post('/api/products', data),
  updateProduct: (productId, data) => api.patch(`/api/products/${productId}`, data),
  deleteProduct: (productId) => api.delete(`/api/products/${productId}`),
};

// ── Orders ────────────────────────────────────────
export const orderAPI = {
  createOrder: (data) => api.post('/api/orders', data),
  getMyOrders: (params) => api.get('/api/orders/my', { params }),
  getOrder: (id) => api.get(`/api/orders/${id}`),
  cancelOrder: (id) => api.post(`/api/orders/${id}/cancel`),
  // Admin
  getAllOrders: (params) => api.get('/api/orders', { params }),
  updateOrderStatus: (id, data) => api.patch(`/api/orders/${id}/status`, data),
};

// ── Admin ──────────────────────────────────────────
export const adminAPI = {
  // Audit logs
  getAuditLogs:      (params) => api.get('/api/admin/audit-logs', { params }),
  // Inventory
  getInventory:      (params) => api.get('/api/admin/inventory', { params }),
  updateStock:       (id, d)  => api.patch(`/api/admin/inventory/${id}`, d),
  // Metadata
  getMetadata:       (type)   => api.get(`/api/admin/metadata/${type}`),
  upsertMetadata:    (type,d) => api.post(`/api/admin/metadata/${type}`, d),
  deleteMetadata:    (type,id)=> api.delete(`/api/admin/metadata/${type}/${id}`),
  // Product management (reuse existing product endpoints)
  getUploadUrl:      (params) => api.get('/api/products/upload-url', { params }),
  createProduct:     (data)   => api.post('/api/products', data),
  updateProduct:     (productId, d)  => api.patch(`/api/products/${productId}`, d),
  deleteProduct:     (productId)     => api.delete(`/api/products/${productId}`),
  getProducts:       (params) => api.get('/api/products', { params }),
  getProduct:        (productId)     => api.get(`/api/products/${productId}`),
  // AI metadata generation
  generateMetadata:  (data)   => api.post('/api/admin/generate-metadata', data),
  // Order management
  getAllOrders:       (params) => api.get('/api/orders', { params }),
  updateOrderStatus: (id, d)  => api.patch(`/api/orders/${id}/status`, d),
};
