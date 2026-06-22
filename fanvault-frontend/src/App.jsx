import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { CartProvider } from './context/CartContext';
import ErrorBoundary from './components/ErrorBoundary';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import AdminRoute from './components/AdminRoute';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminProducts from './pages/admin/AdminProducts';
import AdminProductForm from './pages/admin/AdminProductForm';
import AdminInventory from './pages/admin/AdminInventory';
import AdminCategories from './pages/admin/AdminCategories';
import AdminOrders from './pages/admin/AdminOrders';
import AdminAudit from './pages/admin/AdminAudit';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ConfirmEmailPage from './pages/ConfirmEmailPage';
import ProductsPage from './pages/ProductsPage';
import ProductDetailPage from './pages/ProductDetailPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import OrdersPage from './pages/OrdersPage';
import OrderDetailPage from './pages/OrderDetailPage';
import ProfilePage from './pages/ProfilePage';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function GuestRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (user) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* ── Admin Portal (no Navbar/Footer) ─────────────────────────── */}
      <Route
        path="/admin"
        element={<AdminRoute><AdminLayout /></AdminRoute>}
      >
        <Route index                    element={<AdminDashboard />} />
        <Route path="products"          element={<AdminProducts />} />
        <Route path="products/new"      element={<AdminProductForm />} />
        <Route path="products/:productId/edit" element={<AdminProductForm />} />
        <Route path="inventory"         element={<AdminInventory />} />
        <Route path="categories"        element={<AdminCategories />} />
        <Route path="orders"            element={<AdminOrders />} />
        <Route path="audit"             element={<AdminAudit />} />
      </Route>

      {/* ── Public / User routes (with Navbar/Footer) ───────────────── */}
      <Route path="/*" element={
        <>
          <Navbar />
          <main>
            <Routes>
              <Route path="/"            element={<HomePage />} />
              <Route path="/login"       element={<GuestRoute><LoginPage /></GuestRoute>} />
              <Route path="/register"       element={<GuestRoute><RegisterPage /></GuestRoute>} />
              <Route path="/confirm-email" element={<ConfirmEmailPage />} />
              <Route path="/products"    element={<ProductsPage />} />
              <Route path="/products/:productId" element={<ProductDetailPage />} />
              <Route path="/cart"        element={<CartPage />} />
              <Route path="/checkout"    element={<ProtectedRoute><CheckoutPage /></ProtectedRoute>} />
              <Route path="/orders"      element={<ProtectedRoute><OrdersPage /></ProtectedRoute>} />
              <Route path="/orders/:id"  element={<ProtectedRoute><OrderDetailPage /></ProtectedRoute>} />
              <Route path="/profile"     element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
              <Route path="*"            element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          <Footer />
        </>
      } />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <CartProvider>
          <AppRoutes />
        </CartProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
