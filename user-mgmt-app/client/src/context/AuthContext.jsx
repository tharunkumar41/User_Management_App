import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import { disablePush } from '../firebase';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/auth/me')
      .then((res) => setUser(res.data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (payload) => {
    const res = await api.post('/auth/login', payload);
    setUser(res.data.user);
  }, []);

  // Registering doesn't sign you in: the email must be verified first.
  const register = useCallback(async (payload) => {
    await api.post('/auth/register', payload);
  }, []);

  const googleLogin = useCallback(async (credential) => {
    const res = await api.post('/auth/google', { credential });
    setUser(res.data.user);
  }, []);

  const logout = useCallback(async () => {
    await disablePush(); // must run while the session cookie is still valid
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, googleLogin, register, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}
