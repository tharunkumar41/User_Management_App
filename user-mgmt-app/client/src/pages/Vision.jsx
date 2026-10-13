import { NavLink, Outlet } from 'react-router-dom';

const tools = [
  { to: '/vision/visiting-card', label: 'Visiting Card Reader', desc: 'Upload a business card image and extract name, email, phone, company.' },
  { to: '/vision/face-detection', label: 'Face Detection', desc: 'Upload a video, identify unique persons and list matching frames.' },
  { to: '/vision/object-detection', label: 'Object Detection', desc: 'Upload a video, detect all objects and search by label.' },
  { to: '/vision/vehicle', label: 'Vehicle Identification', desc: 'Find vehicles by color, type, plate, brand or photo match.' },
];

export default function Vision() {
  return (
    <section className="page vision-page">
      <h1>AI Vision Tools</h1>
      <p className="muted">Computer vision features powered by on-device models (MediaPipe + Tesseract).</p>

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
