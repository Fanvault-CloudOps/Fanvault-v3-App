import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI, userAPI } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const { data } = await userAPI.getProfile();
      setProfile(data.profile);
    } catch {
      // Profile may not exist yet
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    const storedUser = localStorage.getItem('user');
    if (token && storedUser) {
      try {
        const parsed = JSON.parse(storedUser);
        if (parsed && typeof parsed === 'object') {
          setUser(parsed);
          loadProfile();
        } else {
          console.warn('[AuthContext] Stored user is not an object, clearing auth state:', storedUser);
          localStorage.clear();
        }
      } catch (err) {
        console.warn('[AuthContext] Failed to parse stored user from localStorage:', { key: 'user', value: storedUser, error: err.message });
        localStorage.clear();
      }
    }
    setLoading(false);
  }, [loadProfile]);

  const login = async (email, password) => {
    const { data } = await authAPI.login({ email, password });
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    // Create profile if doesn't exist
    try {
      await userAPI.createProfile({ email });
    } catch {
      // might already exist
    }
    await loadProfile();
    return data;
  };

  const register = async (email, password, firstName, lastName) => {
    const { data } = await authAPI.register({ email, password, firstName, lastName });
    // Cognito requires email verification before tokens are issued — no tokens in the
    // register response. Do not write to localStorage here; caller redirects to login.
    return data;
  };

  const logout = async () => {
    try { await authAPI.logout(); } catch {}
    localStorage.clear();
    setUser(null);
    setProfile(null);
  };

  const refreshProfile = () => loadProfile();

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, register, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
