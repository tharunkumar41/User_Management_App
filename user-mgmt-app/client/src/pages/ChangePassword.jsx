import { useState } from 'react';
import { Link } from 'react-router-dom';
import Field from '../components/Field';
import api, { parseError } from '../api/client';

const STEPS = ['Confirm it’s you', 'Enter the code', 'New password'];

export default function ChangePassword() {
  const [step, setStep] = useState(0);
  const [currentPassword, setCurrentPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [pw, setPw] = useState({ newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setError('');
    setInfo('');
    setFieldErrors({});
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const p = parseError(err);
      setError(p.message);
      setFieldErrors(p.fieldErrors);
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = (e) => {
    e.preventDefault();
    run(async () => {
      await api.post('/auth/change-password/request-otp', { currentPassword });
      setStep(1);
      setInfo('We emailed you a 6-digit code. It expires in 10 minutes.');
    });
  };

  const resend = () =>
    run(async () => {
      await api.post('/auth/change-password/request-otp', { currentPassword });
      setInfo('A new code is on its way.');
    });

  const verify = (e) => {
    e.preventDefault();
    run(async () => {
      await api.post('/auth/change-password/verify-otp', { otp });
      setStep(2);
    });
  };

  const change = (e) => {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) {
      setFieldErrors({ confirm: ['Passwords do not match'] });
      return;
    }
    run(async () => {
      await api.post('/auth/change-password', { newPassword: pw.newPassword });
      setStep(3);
    });
  };

  return (
    <section className="page narrow">
      <h1>Change password</h1>

      {step < 3 && (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{s}</li>
          ))}
        </ol>
      )}

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {info && <div className="alert alert-success">{info}</div>}

      {step === 0 && (
        <form onSubmit={requestOtp} noValidate>
          <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password"
            value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} error={fieldErrors.currentPassword} />
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending code…' : 'Email me a code'}</button>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={verify} noValidate>
          <Field label="6-digit code" name="otp" inputMode="numeric" maxLength={6} autoComplete="one-time-code"
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldErrors.otp} />
          <div className="actions">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Verify code'}</button>
            <button type="button" className="btn btn-outline" onClick={resend} disabled={busy}>Resend code</button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={change} noValidate>
          <Field label="New password" name="newPassword" type="password" autoComplete="new-password"
            value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
            error={fieldErrors.newPassword} hint="At least 8 characters, with a letter and a number." />
          <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password"
            value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} error={fieldErrors.confirm} />
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>
      )}

      {step === 3 && (
        <div className="alert alert-success">
          Your password has been changed and we sent you a confirmation email. <Link to="/">Back to home</Link>
        </div>
      )}
    </section>
  );
}
