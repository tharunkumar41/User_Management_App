import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Field from '../components/Field';
import Avatar from '../components/Avatar';
import useForm from '../hooks/useForm';
import { useAuth } from '../context/AuthContext';
import api, { parseError } from '../api/client';

export default function EditProfile() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const { values, onChange } = useForm({ name: user.name, phone: user.phone || '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [picMsg, setPicMsg] = useState({ type: '', text: '' });
  const [picBusy, setPicBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setBusy(true);
    try {
      const res = await api.put('/profile', values);
      setUser(res.data.user);
      navigate('/profile');
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  const pick = (e) => {
    const f = e.target.files[0];
    setPicMsg({ type: '', text: '' });
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      setPicMsg({ type: 'error', text: 'Choose a JPG, PNG or WEBP image.' });
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setPicMsg({ type: 'error', text: 'Image must be 2 MB or smaller.' });
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const upload = async () => {
    const form = new FormData();
    form.append('picture', file);
    setPicBusy(true);
    try {
      const res = await api.post('/profile/picture', form);
      setUser(res.data.user);
      setFile(null);
      setPreview(null);
      setPicMsg({ type: 'success', text: 'Photo updated.' });
    } catch (err) {
      setPicMsg({ type: 'error', text: parseError(err).message });
    } finally {
      setPicBusy(false);
    }
  };

  return (
    <section className="page narrow">
      <h1>Edit profile</h1>

      <div className="photo-row">
        {preview ? <img className="avatar" src={preview} alt="Preview" style={{ width: 88, height: 88 }} /> : <Avatar user={user} size={88} />}
        <div>
          <label className="btn btn-outline file-btn">
            Choose photo
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} hidden />
          </label>
          {file && <button className="btn btn-primary" onClick={upload} disabled={picBusy}>{picBusy ? 'Uploading…' : 'Save photo'}</button>}
          <p className="hint">JPG, PNG or WEBP, up to 2 MB.</p>
          {picMsg.text && <p className={picMsg.type === 'error' ? 'error-text' : 'success-text'}>{picMsg.text}</p>}
        </div>
      </div>

      <form onSubmit={save} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Field label="Full name" name="name" value={values.name} onChange={onChange} error={fieldErrors.name} />
        <Field label="Email" name="email" value={user.email} disabled hint="Email can't be changed here." />
        <Field label="Phone" name="phone" type="tel" value={values.phone} onChange={onChange} error={fieldErrors.phone} />
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          <Link className="btn btn-outline" to="/profile">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
