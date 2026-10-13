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

function formatMs(ms) {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function FaceDetection() {
  const [file, setFile] = useState(null);
  const [reference, setReference] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [selectedPerson, setSelectedPerson] = useState(null);
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
    setSelectedPerson(null);
    setProgress(0);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const fd = new FormData();
      fd.append('video', file);
      if (reference) fd.append('reference', reference);
      fd.append('maxFrames', '120');
      const { data } = await api.post('/vision/face-detection', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });
      const final = await pollJob(data.jobId, setProgress, ac.signal);
      setResult(final);
      if (final?.persons?.length) setSelectedPerson(final.persons[0]);
    } catch (err) {
      if (err.message !== 'Cancelled') setError(parseError(err).message || err.message);
    } finally {
      setLoading(false);
    }
  };

  const rm = result?.reference_match;

  return (
    <div className="vision-tool">
      <h2>Face Detection</h2>
      <p className="muted">
        Upload a video to find unique persons. Optionally add a <strong>reference photo</strong> to find
        only that person, with exact times and how long they appear.
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
            {reference ? <span>Reference: {reference.name}</span> : <span>Optional: reference person photo</span>}
            <small>JPG / PNG — find this person only</small>
          </div>
          <input ref={refRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setReference(e.target.files?.[0] || null)} hidden />
        </div>

        <button type="submit" className="btn btn-primary" disabled={!file || loading}>
          {loading ? `Analysing faces… ${progress}%` : reference ? 'Find this person' : 'Detect faces'}
        </button>
        {loading && (
          <div className="progress-bar" role="progressbar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div className="result-card">
          <h3>
            {rm?.enabled
              ? (rm.persons_matched ? `${rm.persons_matched} match(es) for reference person` : 'No match for reference person')
              : `${result.persons_found} person${result.persons_found !== 1 ? 's' : ''} found`}
          </h3>
          <p className="muted">
            Sampled {result.total_frames_sampled} frames · {result.fps?.toFixed?.(1)} fps
            {rm?.enabled && rm.total_duration != null && (
              <> · total presence ≈ <strong>{rm.total_duration}</strong></>
            )}
          </p>

          <div className="person-grid">
            {result.persons?.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`person-chip ${selectedPerson?.id === p.id ? 'active' : ''}`}
                onClick={() => setSelectedPerson(p)}
              >
                {p.representative_crop && (
                  <img src={p.representative_crop} alt={`Person ${p.id}`} className="person-thumb" />
                )}
                <span>
                  Person {p.id}
                  <small>
                    {p.frame_count} frames
                    {p.total_duration ? ` · ${p.total_duration}` : ''}
                    {p.first_seen && p.last_seen ? ` · ${p.first_seen}–${p.last_seen}` : ''}
                  </small>
                </span>
              </button>
            ))}
          </div>

          {selectedPerson && (
            <div className="person-detail">
              <h4>
                Person {selectedPerson.id}
                {selectedPerson.match_score != null && (
                  <span className="muted"> · match {Math.round(selectedPerson.match_score * 100)}%</span>
                )}
              </h4>
              <p className="muted">
                First seen {selectedPerson.first_seen || formatMs(selectedPerson.first_seen_ms)}
                {' '}· last {selectedPerson.last_seen || formatMs(selectedPerson.last_seen_ms)}
                {selectedPerson.total_duration && <> · duration ≈ <strong>{selectedPerson.total_duration}</strong></>}
              </p>

              {selectedPerson.segments?.length > 0 && (
                <div className="segments-block">
                  <strong>Presence segments</strong>
                  <ul className="segment-list">
                    {selectedPerson.segments.map((s, i) => (
                      <li key={i}>
                        <span className="seg-time">{s.start_time} → {s.end_time}</span>
                        <span className="seg-dur">{s.duration}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="frame-grid">
                {selectedPerson.frames?.map((f) => (
                  <div key={f.frame_index} className="frame-card">
                    {f.crop_url && <img src={f.crop_url} alt="" />}
                    <small>
                      {f.timestamp || formatMs(f.timestamp_ms)}
                      {f.match_similarity != null && ` · sim ${Math.round(f.match_similarity * 100)}%`}
                    </small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
