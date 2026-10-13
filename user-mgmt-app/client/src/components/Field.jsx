export default function Field({ label, name, error, hint, ...props }) {
  const errors = Array.isArray(error) ? error : error ? [error] : [];
  return (
    <div className={`field ${errors.length ? 'has-error' : ''}`}>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} {...props} />
      {hint && !errors.length && <p className="hint">{hint}</p>}
      {errors.map((e) => <p key={e} className="error-text">{e}</p>)}
    </div>
  );
}
