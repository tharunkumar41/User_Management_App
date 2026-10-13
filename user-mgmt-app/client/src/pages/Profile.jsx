import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/Avatar';

export default function Profile() {
  const { user } = useAuth();
  const rows = [
    ['Email', user.email],
    ['Phone', user.phone || 'Not added'],
    ['Role', user.role === 'ADMIN' ? 'Administrator' : 'Member'],
    ['Member since', new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })],
  ];
  return (
    <section className="page">
      <div className="profile-head">
        <Avatar user={user} size={88} />
        <div>
          <h1>{user.name}</h1>
          <Link className="btn btn-outline" to="/profile/edit">Edit profile</Link>
        </div>
      </div>
      <dl className="details">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}
