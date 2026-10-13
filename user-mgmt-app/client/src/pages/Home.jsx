import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Home() {
  const { user } = useAuth();
  const firstName = user.name.split(' ')[0];
  return (
    <section className="page">
      <h1 className="welcome">Welcome back, {firstName}</h1>
      <p className="muted">You're signed in as {user.email}.</p>
      <ul className="shortcuts">
        <li><Link to="/chat">Open chat</Link><span>Message other people with text, photos and videos.</span></li>
        <li><Link to="/vision">AI Vision tools</Link><span>Visiting card OCR, face / object / vehicle detection on videos.</span></li>
        <li><Link to="/mock">Mock Tests</Link><span>PYQ & textbook banks, generate papers, take and evaluate tests.</span></li>
        <li><Link to="/profile">View your profile</Link><span>See the details on your account.</span></li>
        <li><Link to="/profile/edit">Edit your profile</Link><span>Update your name, phone number or photo.</span></li>
        <li><Link to="/change-password">Change your password</Link><span>Confirm with a code we email you.</span></li>
      </ul>
    </section>
  );
}
