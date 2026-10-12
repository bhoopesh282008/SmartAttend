import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, login as storedLogin } from './api.js';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// user: undefined while we find out, null when signed out, otherwise the account.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    let alive = true;
    if (!storedLogin.get()) {
      setUser(null);
      return undefined;
    }
    api('/me')
      .then((me) => alive && setUser(me))
      .catch(() => alive && setUser(null));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const signedOut = () => setUser(null);
    window.addEventListener('smartattend:signed-out', signedOut);
    return () => window.removeEventListener('smartattend:signed-out', signedOut);
  }, []);

  const signIn = useCallback(async (userId) => {
    const { token, user: me } = await api('/auth/login', { method: 'POST', body: { userId } });
    storedLogin.set(token);
    setUser(me);
    return me;
  }, []);

  const signOut = useCallback(() => {
    storedLogin.clear();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, signIn, signOut }), [user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
