import { useEffect, useRef, useState } from 'react';
import { useNotifications } from '../context/NotificationContext';

function ago(date) {
  const s = Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationBell() {
  const { items, unread, push, markAllRead, enable, open } = useNotifications();
  const [show, setShow] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!show) return undefined;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setShow(false); };
    const esc = (e) => { if (e.key === 'Escape') setShow(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [show]);

  return (
    <div className="bell-wrap" ref={wrap}>
      <button className="bell" onClick={() => setShow((s) => !s)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={show}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {show && (
        <div className="bell-menu" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            <button className="link-btn" onClick={markAllRead} disabled={!unread}>Mark all read</button>
          </div>

          {push === 'off' && (
            <div className="bell-push">
              <span>Get alerts even when this tab is closed.</span>
              <button className="btn btn-primary btn-sm" onClick={enable}>Enable</button>
            </div>
          )}
          {push === 'blocked' && <p className="bell-push muted-sm">Notifications are blocked in your browser settings.</p>}

          {items.length === 0 ? (
            <p className="bell-empty">You're all caught up.</p>
          ) : (
            <ul className="bell-list">
              {items.map((n) => (
                <li key={n.id}>
                  <button className={`bell-item ${n.readAt ? '' : 'unread'}`} onClick={() => { setShow(false); open(n.data?.url); }}>
                    <span className="bell-title">{n.title}</span>
                    <span className="bell-body">{n.body}</span>
                    <span className="bell-time">{ago(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
