import { useNotifications } from '../context/NotificationContext';

export default function Toasts() {
  const { toasts, dismissToast, open } = useNotifications();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <button className="toast-main" onClick={() => { dismissToast(t.id); open(t.url); }}>
            <strong>{t.title}</strong>
            {t.body && <span>{t.body}</span>}
          </button>
          <button className="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
