import { useEffect, useRef, useState } from 'react';
import api, { parseError } from '../../api/client';

async function pollJob(jobId, setProgress, signal) {
  const started = Date.now();
  while (Date.now() - started < 300000) {
    if (signal?.aborted) throw new Error('Cancelled');
    const { data } = await api.get(`/vision/jobs/${jobId}`, { signal });
    setProgress(data.progress || 0);
    if (data.status === 'done') return data.result;
    if (data.status === 'error') throw new Error(data.error || 'Job failed');
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('Timed out waiting for result');
}

export default function ObjectDetection() {
  const [file, setFile] = useState(null);
  const [reference, setReference] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const videoRef = useRef();
  const refRef = useRef();
  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError('');
    setResult(null);
    setSelected(null);
    setProgress(0);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const fd = new FormData();
      fd.append('video', file);
      if (reference) fd.append('reference', reference);
      if (search.trim()) fd.append('search', search.trim());
      fd.append('maxFrames', '40');
      const { data } = await api.post('/vision/object-detection', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });
      const final = await pollJob(data.jobId, setProgress, ac.signal);
      setResult(final);
      if (final?.reference_match?.enabled) {
        setSelected({ label: 'reference', ...final.reference_match });
      } else if (final?.objects?.length) {
        setSelected(final.objects[0]);
      }
    } catch (err) {
      if (err.message !== 'Cancelled') setError(parseError(err).message || err.message);
    } finally {
      setLoading(false);
    }
  };

  const rm = result?.reference_match;

  return (
    <div className="vision-tool">
      <h2>Object Detection</h2>
      <p className="muted">
        Detect objects in a video. Optionally upload a <strong>reference image</strong> to find matching
        objects with timestamps and duration, or search by label (e.g. person, bottle).
      </p>

      <form onSubmit={submit} className="vision-form">
        <div className="upload-zone" onClick={() => videoRef.current?.click()}>
          <div className="upload-placeholder">
            {file ? <span>{file.name} ({(file.size / 1e6).toFixed(1)} MB)</span> : <span>Click to select a video</span>}
            <small>MP4, WEBM, MOV · max 100 MB</small>
          </div>
          <input ref={videoRef} type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] || null)} hidden />
        </div>

        <div className="upload-zone small" onClick={() => refRef.current?.click()}>
          <div className="upload-placeholder">
            {reference ? <span>Reference: {reference.name}</span> : <span>Optional: reference object photo</span>}
            <small>JPG / PNG — find similar objects only</small>
          </div>
          <input ref={refRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setReference(e.target.files?.[0] || null)} hidden />
        </div>

        <label className="field">
          <span>Search object (optional)</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. person, car, dog" />
        </label>

        <button type="submit" className="btn btn-primary" disabled={!file || loading}>
          {loading ? `Detecting… ${progress}%` : reference ? 'Find matching objects' : 'Detect objects'}
        </button>
        {loading && (
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
        )}
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div className="result-card">
          {rm?.enabled ? (
            <>
              <h3>{rm.matches || 0} reference match(es)</h3>
              <p className="muted">
                Total presence ≈ <strong>{rm.total_duration || '0s'}</strong>
              </p>
              {rm.segments?.length > 0 && (
                <ul className="segment-list">
                  {rm.segments.map((s, i) => (
                    <li key={i}>
                      <span className="seg-time">{s.start_time} → {s.end_time}</span>
                      <span className="seg-dur">{s.duration}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="frame-grid">
                {rm.frames?.map((f, i) => (
                  <div key={i} className="frame-card">
                    {f.crop_url && <img src={f.crop_url} alt="" />}
                    <small>
                      {f.timestamp} · {f.label}
                      {f.match_similarity != null && ` · ${Math.round(f.match_similarity * 100)}%`}
                    </small>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3>{result.unique_labels} unique object types</h3>
              <p className="muted">Sampled {result.total_frames_sampled} frames</p>
              <table className="obj-table">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th>Count</th>
                    <th>Max conf.</th>
                    <th>Time span</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {result.objects?.map((o) => (
                    <tr
                      key={o.label}
                      className={selected?.label === o.label ? 'active-row' : ''}
                      onClick={() => setSelected(o)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><strong>{o.label}</strong></td>
                      <td>{o.count}</td>
                      <td>{Math.round((o.max_confidence || 0) * 100)}%</td>
                      <td>{o.first_seen || '—'} – {o.last_seen || '—'}</td>
                      <td>{o.total_duration || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selected?.segments && (
                <div className="segments-block" style={{ marginTop: '1rem' }}>
                  <strong>{selected.label} — presence segments</strong>
                  <ul className="segment-list">
                    {selected.segments.map((s, i) => (
                      <li key={i}>
                        <span className="seg-time">{s.start_time} → {s.end_time}</span>
                        <span className="seg-dur">{s.duration}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="frame-grid">
                    {selected.frames?.map((f, i) => (
                      <div key={i} className="frame-card">
                        {f.crop_url && <img src={f.crop_url} alt="" />}
                        <small>{f.timestamp}</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
