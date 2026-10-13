import { useEffect, useState, useRef } from 'react';
import api, { parseError } from '../../api/client';

export default function PyqUpload() {
  const [sources, setSources] = useState([]);
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('');
  const [file, setFile] = useState(null);
  const [keyFile, setKeyFile] = useState(null);
  const [linkedId, setLinkedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [genCount, setGenCount] = useState(20);
  const [genTitle, setGenTitle] = useState('');
  const fileRef = useRef();
  const keyRef = useRef();

  const load = async () => {
    const { data } = await api.get('/mock/sources', { params: { type: 'PYQ' } });
    const keys = await api.get('/mock/sources', { params: { type: 'ANSWER_KEY' } });
    setSources([...(data.data || []), ...(keys.data.data || [])]);
  };

  useEffect(() => { load().catch(() => {}); }, []);

  const uploadPaper = async (e) => {
    e.preventDefault();
    if (!file || !title) return;
    setLoading(true); setErr(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      fd.append('type', 'PYQ');
      if (year) fd.append('year', year);
      const { data } = await api.post('/mock/sources', fd);
      setMsg(`Uploaded. Extracted ${data.questionsCreated} questions.`);
      setTitle(''); setYear(''); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const uploadKey = async (e) => {
    e.preventDefault();
    if (!keyFile || !linkedId) return;
    setLoading(true); setErr(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', keyFile);
      fd.append('title', `Answer key`);
      fd.append('type', 'ANSWER_KEY');
      fd.append('linkedSourceId', linkedId);
      const { data } = await api.post('/mock/sources', fd);
      setMsg(`Answer key applied to ${data.keysApplied} questions (${data.keyCount} keys found).`);
      setKeyFile(null); setLinkedId('');
      if (keyRef.current) keyRef.current.value = '';
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const generate = async () => {
    setLoading(true); setErr(''); setMsg('');
    try {
      const pyqIds = sources.filter((s) => s.type === 'PYQ').map((s) => s.id);
      const { data } = await api.post('/mock/papers/generate', {
        type: 'PYQ',
        title: genTitle || undefined,
        totalQuestions: genCount,
        durationMin: 60,
        sourceIds: pyqIds.length ? pyqIds : undefined,
      });
      setMsg(`Paper created: "${data.title}" with ${data.totalQuestions} questions. Go to Conduct Mock Test to take it.`);
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const pyqSources = sources.filter((s) => s.type === 'PYQ');

  return (
    <div className="vision-tool">
      <h2>Previous Years Questions</h2>
      <p className="muted">Upload past MCQ papers (PDF/DOCX/TXT). Then upload answer keys linked to a paper. Generate a random mock paper.</p>

      {err && <div className="alert alert-error">{err}</div>}
      {msg && <div className="alert" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}>{msg}</div>}

      <form onSubmit={uploadPaper} className="vision-form">
        <h3>1. Upload question paper</h3>
        <label className="field"><span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. NEET 2023 Biology" required />
        </label>
        <label className="field"><span>Year (optional)</span>
          <input value={year} onChange={(e) => setYear(e.target.value)} placeholder="2023" />
        </label>
        <label className="field"><span>File (PDF / DOCX / TXT)</span>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.doc,.txt" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
        </label>
        <button className="btn btn-primary" disabled={loading || !file}>Upload &amp; extract MCQs</button>
      </form>

      <form onSubmit={uploadKey} className="vision-form" style={{ marginTop: '1.5rem' }}>
        <h3>2. Upload answer key</h3>
        <label className="field"><span>Link to paper</span>
          <select value={linkedId} onChange={(e) => setLinkedId(e.target.value)} required>
            <option value="">Select PYQ source…</option>
            {pyqSources.map((s) => (
              <option key={s.id} value={s.id}>{s.title} ({s._count?.questions || 0} Qs)</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Answer key file</span>
          <input ref={keyRef} type="file" accept=".pdf,.docx,.txt" onChange={(e) => setKeyFile(e.target.files?.[0] || null)} required />
        </label>
        <button className="btn btn-primary" disabled={loading || !keyFile || !linkedId}>Apply answer key</button>
      </form>

      <div className="vision-form" style={{ marginTop: '1.5rem' }}>
        <h3>3. Generate random PYQ mock paper</h3>
        <label className="field"><span>Paper title</span>
          <input value={genTitle} onChange={(e) => setGenTitle(e.target.value)} placeholder="Auto if empty" />
        </label>
        <label className="field"><span>Number of questions</span>
          <input type="number" min={1} max={100} value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-primary" disabled={loading} onClick={generate}>Generate paper</button>
      </div>

      <div className="result-card" style={{ marginTop: '1.5rem' }}>
        <h3>Uploaded sources</h3>
        <table className="obj-table">
          <thead><tr><th>Title</th><th>Type</th><th>Year</th><th>Questions</th></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.type}</td>
                <td>{s.year || '—'}</td>
                <td>{s._count?.questions ?? '—'}</td>
              </tr>
            ))}
            {!sources.length && <tr><td colSpan={4} className="muted">No sources yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
