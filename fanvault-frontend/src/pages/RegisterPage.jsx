import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Zap, ArrowRight, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import './AuthPage.css';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const passwordChecks = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'Contains a number', met: /\d/.test(password) },
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) { toast.error('Please enter your full name'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      await register(email, password, firstName.trim(), lastName.trim());
      toast.success('Check your email for a confirmation code');
      navigate('/confirm-email', { state: { email } });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-logo">
          <Zap size={28} />
          <span>FanVault</span>
        </div>
        <div className="auth-header">
          <h1>Join FanVault</h1>
          <p>Create your account and start shopping</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="reg-first">First name</label>
              <input
                id="reg-first"
                type="text"
                className="form-input"
                placeholder="Jane"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                autoFocus
                autoComplete="given-name"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="reg-last">Last name</label>
              <input
                id="reg-last"
                type="text"
                className="form-input"
                placeholder="Smith"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                autoComplete="family-name"
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reg-email">Email address</label>
            <input
              id="reg-email"
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reg-password">Password</label>
            <div className="input-with-icon">
              <input
                id="reg-password"
                type={showPass ? 'text' : 'password'}
                className="form-input"
                placeholder="Min. 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="input-icon-btn" onClick={() => setShowPass(!showPass)}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {password && (
              <div className="password-checks">
                {passwordChecks.map((c) => (
                  <div key={c.label} className={`password-check ${c.met ? 'met' : ''}`}>
                    <Check size={11} /> {c.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="reg-confirm">Confirm password</label>
            <input
              id="reg-confirm"
              type={showPass ? 'text' : 'password'}
              className="form-input"
              placeholder="Repeat password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading}>
            {loading ? <><div className="spinner spinner-sm" />Creating account...</> : <>Create Account <ArrowRight size={16} /></>}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>

      <div className="auth-illustration">
        <div className="auth-quote">
          <div className="quote-emojis">🏆 🎬 🏅 🎭 ⚡</div>
          <h2>Wear What You Love</h2>
          <p>From Real Madrid jerseys to Harry Potter robes — get it all officially licensed.</p>
        </div>
      </div>
    </div>
  );
}
