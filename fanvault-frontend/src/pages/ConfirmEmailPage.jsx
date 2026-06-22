import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Zap, ArrowRight, MailCheck } from 'lucide-react';
import { authAPI } from '../api/client';
import toast from 'react-hot-toast';
import './AuthPage.css';

export default function ConfirmEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (code.length !== 6) { toast.error('Enter the 6-digit code from your email'); return; }
    setLoading(true);
    try {
      await authAPI.confirm({ email, code });
      toast.success('Email confirmed! You can now sign in.');
      navigate('/login', { state: { email } });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid or expired code');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!email) { toast.error('Enter your email address first'); return; }
    setResending(true);
    try {
      await authAPI.resendCode({ email });
      toast.success('New code sent — check your inbox');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not resend code');
    } finally {
      setResending(false);
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
          <h1>Confirm your email</h1>
          <p>We sent a 6-digit code to <strong>{email || 'your email'}</strong></p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {!location.state?.email && (
            <div className="form-group">
              <label className="form-label" htmlFor="confirm-email">Email address</label>
              <input
                id="confirm-email"
                type="email"
                className="form-input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
          )}
          <div className="form-group">
            <label className="form-label" htmlFor="confirm-code">Confirmation code</label>
            <input
              id="confirm-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              className="form-input"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
              autoFocus={!!location.state?.email}
              style={{ letterSpacing: '0.25em', fontSize: '1.25rem' }}
            />
          </div>

          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading}>
            {loading
              ? <><div className="spinner spinner-sm" />Confirming...</>
              : <>Confirm Email <ArrowRight size={16} /></>}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-full"
            onClick={handleResend}
            disabled={resending}
          >
            {resending ? 'Sending...' : "Didn't receive it? Resend code"}
          </button>
        </form>

        <p className="auth-switch">
          Already confirmed? <Link to="/login">Sign in</Link>
        </p>
      </div>

      <div className="auth-illustration">
        <div className="auth-quote">
          <div className="quote-emojis">
            <MailCheck size={64} color="white" />
          </div>
          <h2>One last step</h2>
          <p>Check your inbox for the code we just sent and enter it to activate your account.</p>
        </div>
      </div>
    </div>
  );
}
