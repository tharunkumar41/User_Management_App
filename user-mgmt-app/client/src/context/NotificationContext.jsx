import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';
import { enablePush, pushConfigured, pushSupported } from '../firebase';

const NotificationContext = createContext(null);
export const useNotifications = () => useContext(NotificationContext);

export function NotificationProvider({ children }) {
  const { user } = useAuth();
  const socket = useSocket();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState([]);
  // 'unsupported' | 'off' | 'on' | 'blocked'
  const [push, setPush] = useState('unsupported');

  const load = useCallback(
    () => api.get('/notifications').then((r) => { setItems(r.data.data); setUnread(r.data.unread); }).catch(() => {}),
    []
  );

  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const showToast = useCallback((toast) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((t) => [...t.slice(-2), { ...toast, id }]);
    setTimeout(() => dismissToast(id), 6000);
  }, [dismissToast]);

  // Initial list.
  useEffect(() => {
    if (user) load();
    else { setItems([]); setUnread(0); }
  }, [user?.id, load]);

  // Realtime over the socket.
  useEffect(() => {
    if (!socket) return undefined;
    const onNew = (n) => {
      setItems((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 30));
      setUnread((c) => c + 1);
      const viewing = n.data?.url && pathRef.current === n.data.url; // already looking at that chat
      if (!viewing) showToast({ title: n.title, body: n.body, url: n.data?.url });
    };
    socket.on('notification:new', onNew);
    socket.on('notification:sync', load);
    socket.on('connect', load); // catch up after a reconnect
    return () => {
      socket.off('notification:new', onNew);
      socket.off('notification:sync', load);
      socket.off('connect', load);
    };
  }, [socket, load, showToast]);

  // Push state. If permission was already granted, silently refresh this browser's token (they can rotate).
  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      if (!(await pushSupported())) return;
      if (Notification.permission === 'denied') return alive && setPush('blocked');
      if (Notification.permission === 'granted') {
        try { await enablePush(); alive && setPush('on'); } catch { alive && setPush('off'); }
      } else {
        alive && setPush('off');
      }
    })();
    return () => { alive = false; };
  }, [user?.id]);

  // Messages from the service worker: in-app toast while the tab is visible, and click-to-navigate.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (e) => {
      if (e.data?.type === 'navigate') navigate(e.data.url);
      if (e.data?.type === 'push') {
        load();
        showToast({ title: e.data.data?.title, body: e.data.data?.body, url: e.data.data?.url });
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.startMessages?.();
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate, load, showToast]);

  const markAllRead = useCallback(async () => {
    setUnread(0);
    setItems((list) => list.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
    await api.post('/notifications/read').catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    try {
      await enablePush();
      setPush('on');
      showToast({ title: 'Notifications on', body: "You'll get alerts when you're away from the app." });
    } catch (err) {
      setPush(typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'off');
      showToast({ title: 'Could not enable notifications', body: err.message });
    }
  }, [showToast]);

  const open = useCallback((url) => url && navigate(url), [navigate]);

  return (
    <NotificationContext.Provider
      value={{ items, unread, push, pushConfigured, markAllRead, enable, open, toasts, dismissToast }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
