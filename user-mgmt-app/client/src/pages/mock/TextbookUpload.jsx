import { useEffect, useState, useRef } from 'react';
import api, { parseError } from '../../api/client';

const SAMPLE = `1. What is the powerhouse of the cell?
(a) Nucleus
(b) Mitochondria
(c) Ribosome
(d) Golgi body

2. Which gas do plants absorb for photosynthesis?
(a) Oxygen
(b) Nitrogen
(c) Carbon dioxide
(d) Hydrogen

3. Water boils at what temperature at sea level?
(a) 90°C
(b) 100°C
(c) 110°C
(d) 120°C
`;

export default function TextbookUpload() {
  const [sources, setSources] = useState([]);
  const [title, setTitle] = useState('');
  const [chapter, setChapter] = useState('');
  const [weightage, setWeightage] = useState(1);
  const [file, setFile] = useState(null);
  const [pasteText, setPasteText] = useState('');
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
    const { data } = await api.get('/mock/sources', { params: { type: 'TEXTBOOK' } });
    setSources(data.data || []);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const upload = async (e) => {
    e.preventDefault();
    if (!file || !title) return;
    setLoading(true); setErr(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      fd.append('type', 'TEXTBOOK');
      if (chapter) fd.append('chapter', chapter);
      fd.append('weightage', String(weightage));
      const { data } = await api.post('/mock/sources', fd);
      if (data.questionsCreated === 0) {
        setMsg(
          'File saved but no questions could be built. Use a text-based chapter (not a scanned image), or paste chapter prose below, then Re-parse.'
        );
      } else {
        setMsg(`Chapter uploaded. Extracted ${data.questionsCreated} MCQs.`);
      }
      setTitle(''); setChapter(''); setWeightage(1); setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const paste = async (e) => {
    e.preventDefault();
    if (!title || !pasteText.trim()) return;
    setLoading(true); setErr(''); setMsg('');
    try {
      const { data } = await api.post('/mock/sources/paste', {
        title,
        type: 'TEXTBOOK',
        chapter: chapter || undefined,
        weightage,
        text: pasteText,
      });
      if (data.questionsCreated === 0) {
        setErr(data.hint || 'No MCQs detected in pasted text.');
      } else {
        setMsg(`Created from paste: ${data.questionsCreated} questions.`);
        setPasteText('');
        setTitle('');
        setChapter('');
      }
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const reparse = async (id) => {
    setLoading(true); setErr(''); setMsg('');
    try {
      const { data } = await api.post(`/mock/sources/${id}/reparse`);
      if (data.questionsCreated === 0) {
        setErr(
          (data.hint || 'Still 0 questions.') +
          (data.textLength != null ? ` Text length: ${data.textLength}.` : '') +
          (data.textPreview ? ` Preview: “${data.textPreview.slice(0, 120)}…”` : '')
        );
      } else {
        setMsg(`Re-parsed: ${data.questionsCreated} questions.`);
      }
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
      fd.append('title', 'Chapter answer key');
      fd.append('type', 'ANSWER_KEY');
      fd.append('linkedSourceId', linkedId);
      const { data } = await api.post('/mock/sources', fd);
      setMsg(`Answer key applied to ${data.keysApplied} questions (${data.keyCount} keys parsed).`);
      setKeyFile(null); setLinkedId('');
      if (keyRef.current) keyRef.current.value = '';
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const updateWeight = async (id, w) => {
    await api.patch(`/mock/sources/${id}`, { weightage: w });
    await load();
  };

  const generate = async () => {
    setLoading(true); setErr(''); setMsg('');
    try {
      const { data } = await api.post('/mock/papers/generate', {
        type: 'TEXTBOOK',
        title: genTitle || undefined,
        totalQuestions: genCount,
        durationMin: 60,
        sourceIds: sources.map((s) => s.id),
      });
      setMsg(`Paper created: "${data.title}" (${data.totalQuestions} Qs). Open Conduct Mock Test.`);
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const hasQuestions = sources.some((s) => (s._count?.questions || 0) > 0);

  return (
    <div className="vision-tool">
      <h2>Text Book Mock Test</h2>
      <p className="muted">
        Upload a <strong>chapter</strong> → system <strong>generates questions</strong> from it. Upload an <strong>answer key</strong> later for scoring. Without a key, the test only shows what the user selected.
      </p>

      {err && <div className="alert alert-error">{err}</div>}
      {msg && <div className="alert" style={{ background: 'var(--ok-bg)', color: 'var(--ok)' }}>{msg}</div>}

      <form onSubmit={upload} className="vision-form">
        <h3>1. Upload chapter file</h3>
        <label className="field"><span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chapter 3 — Cell Structure" />
        </label>
        <label className="field"><span>Chapter name</span>
          <input value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="Cell Structure" />
        </label>
        <label className="field"><span>Weightage</span>
          <input type="number" step="0.1" min="0.1" value={weightage} onChange={(e) => setWeightage(Number(e.target.value))} />
        </label>
        <label className="field"><span>File (PDF / DOCX / TXT)</span>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <button className="btn btn-primary" disabled={loading || !file || !title}>Upload chapter</button>
      </form>

      {/* <form onSubmit={paste} className="vision-form" style={{ marginTop: '1.5rem' }}>
        <h3>1b. Or paste chapter text (if PDF has no text)</h3>
        <label className="field"><span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chapter 3 sample" />
        </label>
        <label className="field"><span>MCQ text</span>
          <textarea
            rows={10}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={SAMPLE}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" onClick={() => setPasteText(SAMPLE)}>Load sample</button>
          <button className="btn btn-primary" disabled={loading || !pasteText.trim() || !title}>Generate questions from text</button>
        </div>
      </form> */}

      <form onSubmit={uploadKey} className="vision-form" style={{ marginTop: '1.5rem' }}>
        <h3>2. Answer key (required only if you want auto-scoring)</h3>
        <label className="field"><span>Link to chapter</span>
          <select value={linkedId} onChange={(e) => setLinkedId(e.target.value)}>
            <option value="">Select chapter…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.title} ({s._count?.questions || 0} Qs)</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Answer key file</span>
          <input ref={keyRef} type="file" accept=".pdf,.docx,.txt" onChange={(e) => setKeyFile(e.target.files?.[0] || null)} />
        </label>
        <button className="btn btn-primary" disabled={loading || !keyFile || !linkedId}>Apply answer key</button>
      </form>

      <div className="result-card" style={{ marginTop: '1.5rem' }}>
        <h3>Chapters</h3>
        <table className="obj-table">
          <thead><tr><th>Title</th><th>Chapter</th><th>Questions</th><th>Weight</th><th></th></tr></thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.chapter || '—'}</td>
                <td>{s._count?.questions ?? 0}</td>
                <td>
                  <input
                    type="number" step="0.1" min="0.1" style={{ width: 70 }}
                    defaultValue={s.weightage}
                    onBlur={(e) => updateWeight(s.id, Number(e.target.value))}
                  />
                </td>
                <td>
                  {(s._count?.questions || 0) === 0 && (
                    <button type="button" className="btn btn-outline btn-sm" disabled={loading} onClick={() => reparse(s.id)}>
                      Re-parse
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!sources.length && <tr><td colSpan={5} className="muted">No chapters yet</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="vision-form" style={{ marginTop: '1.5rem' }}>
        <h3>3. Generate weighted mock paper</h3>
        <label className="field"><span>Title</span>
          <input value={genTitle} onChange={(e) => setGenTitle(e.target.value)} />
        </label>
        <label className="field"><span>Questions</span>
          <input type="number" min={1} max={100} value={genCount} onChange={(e) => setGenCount(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-primary" disabled={loading || !hasQuestions} onClick={generate}>
          Generate paper
        </button>
        {!hasQuestions && sources.length > 0 && (
          <p className="muted">All chapters have 0 questions. Use <strong>Paste MCQs</strong> or a text-based PDF with numbered options.</p>
        )}
      </div>
    </div>
  );
}
