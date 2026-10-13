import { NavLink, Outlet } from 'react-router-dom';

const tools = [
  { to: '/mock/pyq', label: 'Previous Years (PYQ)', desc: 'Upload past papers & answer keys, generate random MCQ papers.' },
  { to: '/mock/textbook', label: 'Text Book Mock', desc: 'Upload chapter PDFs/DOCX, set weightage, generate weighted papers.' },
  { to: '/mock/tests', label: 'Conduct Mock Test', desc: 'Take a generated paper, submit answers, auto-evaluate with keys.' },
];

export default function Mock() {
  return (
    <section className="page vision-page">
      <h1>Mock Tests</h1>
      <p className="muted">Build question banks from PDFs and run scored MCQ mock tests.</p>
      <div className="vision-nav">
        {tools.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => `vision-card ${isActive ? 'active' : ''}`}>
            <strong>{t.label}</strong>
            <span>{t.desc}</span>
          </NavLink>
        ))}
      </div>
      <div className="vision-outlet">
        <Outlet />
      </div>
    </section>
  );
}
