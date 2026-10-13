import { useState, useRef } from 'react';
import api, { parseError } from '../../api/client';

export default function VisitingCard() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const inputRef = useRef();

  const onFile = (e) => {
    const f = e.target.files?.[0];
    setResult(null);
    setError('');
    if (!f) { setFile(null); setPreview(null); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const { data } = await api.post('/vision/visiting-card', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 90000,
      });
      setResult(data);
    } catch (err) {
      setError(parseError(err).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="vision-tool">
      <h2>Visiting Card Reader</h2>
      <p className="muted">Upload a clear photo of a business / visiting card. OCR extracts contact details.</p>

      <form onSubmit={submit} className="vision-form">
        <div className="upload-zone" onClick={() => inputRef.current?.click()}>
          {preview ? (
            <img src={preview} alt="Card preview" className="preview-img" />
          ) : (
            <div className="upload-placeholder">
              <span>Click or drop an image</span>
              <small>JPG, PNG, WEBP · max 10 MB</small>
            </div>
          )}
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile} hidden />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!file || loading}>
          {loading ? 'Reading card…' : 'Extract details'}
        </button>
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div className="result-card">
          <h3>Extracted profile</h3>
          <dl className="result-dl">
            {result.name && <><dt>Name</dt><dd>{result.name}</dd></>}
            {result.title && <><dt>Title</dt><dd>{result.title}</dd></>}
            {result.company && <><dt>Company</dt><dd>{result.company}</dd></>}
            {result.emails?.length > 0 && <><dt>Email</dt><dd>{result.emails.join(', ')}</dd></>}
            {result.phones?.length > 0 && <><dt>Phone</dt><dd>{result.phones.join(', ')}</dd></>}
            {result.websites?.length > 0 && <><dt>Website</dt><dd>{result.websites.join(', ')}</dd></>}
            {result.address && <><dt>Address</dt><dd>{result.address}</dd></>}
          </dl>
          {result.raw_text && (
            <details>
              <summary>Raw OCR text</summary>
              <pre className="raw-text">{result.raw_text}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
