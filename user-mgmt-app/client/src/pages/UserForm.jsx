import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Field from '../components/Field';
import useForm from '../hooks/useForm';
import { useAuth } from '../context/AuthContext';
import api, { parseError, downloadFile } from '../api/client';

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'user';

export default function UserForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { user: me, setUser } = useAuth();
  const { values, setValues, onChange } = useForm({ name: '', email: '', phone: '', role: 'USER', password: '' });
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    api.get(`/users/${id}`)
      .then((res) => {
        const u = res.data.user;
        setValues({ name: u.name, email: u.email, phone: u.phone || '', role: u.role, password: '' });
      })
      .catch((err) => setError(parseError(err).message))
      .finally(() => setLoading(false));
  }, [id, isEdit, setValues]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    setBusy(true);
    try {
      if (isEdit) {
        const { name, email, phone, role } = values;
        const res = await api.put(`/users/${id}`, { name, email, phone, role });
        if (id === me.id) setUser((u) => ({ ...u, ...res.data.user })); // keep the header in sync
      } else {
        await api.post('/users', values);
      }
      navigate('/users');
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    setError('');
    try { await downloadFile(`/users/${id}/pdf`, {}, `profile-${slug(values.name)}.pdf`); } catch (err) { setError(err.message); }
  };

  if (loading) return <section className="page narrow"><p className="muted">Loading…</p></section>;

  const editingSelf = isEdit && id === me.id;

  return (
    <section className="page narrow">
      <h1>{isEdit ? 'Edit user' : 'Add user'}</h1>
      <p className="muted">{isEdit ? 'Update this person’s details.' : 'Create an account for someone.'}</p>

      <form onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Field label="Full name" name="name" value={values.name} onChange={onChange} error={fieldErrors.name} />
        <Field label="Email" name="email" type="email" value={values.email} onChange={onChange} error={fieldErrors.email} />
        <Field label="Phone" name="phone" type="tel" value={values.phone} onChange={onChange} error={fieldErrors.phone} />

        <div className={`field ${fieldErrors.role ? 'has-error' : ''}`}>
          <label htmlFor="role">Role</label>
          <select id="role" name="role" value={values.role} onChange={onChange} disabled={editingSelf}>
            <option value="USER">Member</option>
            <option value="ADMIN">Administrator</option>
          </select>
          {editingSelf && <p className="hint">You can’t change your own role.</p>}
          {fieldErrors.role && <p className="error-text">{fieldErrors.role[0]}</p>}
        </div>

        {!isEdit && (
          <Field label="Password (optional)" name="password" type="password" autoComplete="new-password" value={values.password} onChange={onChange}
            error={fieldErrors.password} hint="Leave blank and we’ll email them a link to choose their own password." />
        )}

        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add user'}</button>
          <Link className="btn btn-outline" to="/users">Cancel</Link>
          {isEdit && <button type="button" className="btn btn-outline" onClick={exportPdf}>Export profile as PDF</button>}
        </div>
      </form>
    </section>
  );
}
