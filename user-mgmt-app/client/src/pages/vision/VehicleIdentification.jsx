import { useState, useRef, useEffect } from 'react';
import api, { parseError } from '../../api/client';

async function pollJob(jobId, onProgress, signal) {
  while (!signal.aborted) {
    const { data } = await api.get(`/vision/jobs/${jobId}`);
    onProgress(data.progress ?? 0);
    if (data.status === 'done') return data.result;
    if (data.status === 'error') throw new Error(data.error || 'Processing failed');
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Cancelled');
}

export default function VehicleIdentification() {
  const [videos, setVideos] = useState([]);
  const [photo, setPhoto] = useState(null);
  const [filters, setFilters] = useState({ color: '', type: '', number: '', brand: '' });
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const videoRef = useRef();
  const photoRef = useRef();
  const abortRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!videos.length) return;
    setLoading(true);
    setError('');
    setResult(null);
    setProgress(0);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const fd = new FormData();
      videos.forEach((v) => fd.append('videos', v));
      if (photo) fd.append('photo', photo);
      Object.entries(filters).forEach(([k, v]) => { if (v) fd.append(k, v); });
      fd.append('maxFrames', '80');
      const { data } = await api.post('/vision/vehicle-identification', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
      });
      const final = await pollJob(data.jobId, setProgress, ac.signal);
      setResult(final);
    } catch (err) {
      if (err.message !== 'Cancelled') setError(parseError(err).message || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="vision-tool">
      <h2>Vehicle Identification</h2>
      <p className="muted">
        Detect vehicles across one or more videos. Filter by color, type, number plate, and brand. Optional reference photo match.
      </p>

      <form onSubmit={submit} className="vision-form">
        <div className="upload-zone" onClick={() => videoRef.current?.click()}>
          <div className="upload-placeholder">
            {videos.length
              ? <span>{videos.length} video(s): {videos.map((v) => v.name).join(', ')}</span>
              : <span>Click to select one or more videos</span>}
            <small>MP4, WEBM, MOV · multiple allowed · max 100 MB each</small>
          </div>
          <input
            ref={videoRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            multiple
            onChange={(e) => setVideos(Array.from(e.target.files || []))}
            hidden
          />
        </div>

        <div className="upload-zone small" onClick={() => photoRef.current?.click()}>
          <div className="upload-placeholder">
            {photo ? <span>{photo.name}</span> : <span>Optional: reference photo for matching</span>}
            <small>JPG / PNG</small>
          </div>
          <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] || null)} hidden />
        </div>

        <div className="filter-grid">
          <label className="field">
            <span>Color</span>
            <input value={filters.color} onChange={(e) => setFilters((f) => ({ ...f, color: e.target.value }))} placeholder="red, blue, white…" />
          </label>
          <label className="field">
            <span>Type</span>
            <input value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))} placeholder="car, truck, bus…" />
          </label>
          <label className="field">
            <span>Number plate</span>
            <input value={filters.number} onChange={(e) => setFilters((f) => ({ ...f, number: e.target.value }))} placeholder="ABC123" />
          </label>
          <label className="field">
            <span>Brand</span>
            <input value={filters.brand} onChange={(e) => setFilters((f) => ({ ...f, brand: e.target.value }))} placeholder="Toyota, Honda, BMW…" />
          </label>
        </div>

        <button type="submit" className="btn btn-primary" disabled={!videos.length || loading}>
          {loading ? `Identifying vehicles… ${progress}%` : 'Identify vehicles'}
        </button>
        {loading && (
          <div className="progress-bar" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </form>

      {error && <div className="alert alert-error">{error}</div>}

      {result && (
        <div className="result-card">
          <h3>{result.vehicles_detected} unique vehicle{result.vehicles_detected !== 1 ? 's' : ''}</h3>
          <p className="muted">
            Matching: {result.matching_vehicles?.length || 0}
            {result.vehicles_total != null && <> / {result.vehicles_total} detected</>}
          </p>
          {result.ocr_stats && (
            <p className="muted">
              OCR: plates read on {result.ocr_stats.plates_read ?? 0} vehicle(s),
              brands on {result.ocr_stats.brands_read ?? 0}
            </p>
          )}
          {result.plates_detected?.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <strong>Plates OCR read:</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {result.plates_detected.map((pl) => (
                  <code key={pl} style={{ background: '#f0f0f0', padding: '2px 8px', borderRadius: 4 }}>{pl}</code>
                ))}
              </div>
              <small className="muted">Use one of these values in the plate filter (OCR may differ slightly from the real plate).</small>
            </div>
          )}
          {result.closest_plates?.length > 0 && (
            <div className="muted" style={{ marginBottom: '0.75rem' }}>
              Closest to your search:{' '}
              {result.closest_plates.map((c) => `${c.plate} (${Math.round((c.similarity || 0) * 100)}%)`).join(' · ')}
            </div>
          )}
          {result.filter_warnings?.length > 0 && (
            <div className="alert" style={{ background: '#fff8e6', color: '#8a6d00', marginBottom: '0.75rem' }}>
              {result.filter_warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {result.filters_applied && (
            <p className="muted">
              Filters: {[
                result.filters_applied.color && `color=${result.filters_applied.color}`,
                result.filters_applied.type && `type=${result.filters_applied.type}`,
                result.filters_applied.number && `plate=${result.filters_applied.number}`,
                result.filters_applied.brand && `brand=${result.filters_applied.brand}`,
              ].filter(Boolean).join(' · ') || 'none'}
            </p>
          )}

          {result.summary?.length > 0 && (
            <>
              <h4>Summary by type, color &amp; brand</h4>
              <div className="person-grid">
                {result.summary.map((s, i) => (
                  <div key={i} className="person-chip static">
                    {s.samples?.[0]?.crop_url && <img src={s.samples[0].crop_url} alt="" />}
                    <span>{s.type} · {s.color}{s.brand ? ` · ${s.brand}` : ''}</span>
                    <small>×{s.count}</small>
                  </div>
                ))}
              </div>
            </>
          )}

          {result.matching_vehicles?.length > 0 && (
            <>
              <h4>Matching vehicles</h4>
              <div className="frame-thumbs">
                {result.matching_vehicles.map((v, i) => (
                  <div key={i} className="frame-thumb vehicle-card">
                    {v.crop_url && <img src={v.crop_url} alt={v.type} />}
                    <div>
                      <strong>{v.type}</strong> · {v.color}
                      {v.brand && <div>Brand: {v.brand}</div>}
                      {v.number_plate && <div>Plate: {v.number_plate}</div>}
                      {v.photo_similarity != null && <div>Photo match: {(v.photo_similarity * 100).toFixed(0)}%</div>}
                      <small>
                        seen {((v.first_seen_ms ?? v.timestamp_ms) / 1000).toFixed(1)}s–{((v.last_seen_ms ?? v.timestamp_ms) / 1000).toFixed(1)}s
                        {v.appearances ? ` · ${v.appearances} frames` : ''} · conf {(v.score * 100).toFixed(0)}%
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
