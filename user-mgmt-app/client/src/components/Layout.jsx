import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Avatar from './Avatar';
import NotificationBell from './NotificationBell';
import Toasts from './Toasts';

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/chat', label: 'Chat' },
  { to: '/vision', label: 'AI Vision' },
  { to: '/mock', label: 'Mock Tests' },
  { to: '/profile', label: 'My profile' },
  { to: '/change-password', label: 'Change password' },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navLinks = user.role === 'ADMIN' ? [links[0], { to: '/users', label: 'Users' }, ...links.slice(1)] : links;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      <header className="topbar">
        <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle menu" aria-expanded={open}>
          <span /><span /><span />
        </button>
        <span className="logo">Roster</span>
        <div className="topbar-user">
          <NotificationBell />
          <span className="topbar-name">{user.name}</span>
          <Avatar user={user} size={34} />
        </div>
      </header>

      <div className={`scrim ${open ? 'show' : ''}`} onClick={() => setOpen(false)} />
      <nav className={`sidebar ${open ? 'open' : ''}`}>
        {navLinks.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} onClick={() => setOpen(false)}
            className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            {l.label}
          </NavLink>
        ))}
        <button className="nav-link logout" onClick={handleLogout}>Sign out</button>
      </nav>

      <main className="content">
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
