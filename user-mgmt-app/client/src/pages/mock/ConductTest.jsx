import { useEffect, useState } from 'react';
import api, { parseError } from '../../api/client';

export default function ConductTest() {
  const [papers, setPapers] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [active, setActive] = useState(null); // { attempt, questions, answers: {} }
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const [p, a] = await Promise.all([
      api.get('/mock/papers'),
      api.get('/mock/attempts'),
    ]);
    setPapers(p.data.data || []);
    setAttempts(a.data.data || []);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const start = async (paperId) => {
    setLoading(true); setErr(''); setResult(null);
    try {
      const { data } = await api.post(`/mock/papers/${paperId}/attempts`);
      const answers = {};
      data.questions.forEach((q) => { answers[q.id] = null; });
      setActive({ ...data, answers });
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  const select = (qid, letter) => {
    setActive((a) => ({ ...a, answers: { ...a.answers, [qid]: letter } }));
  };

  const submit = async () => {
    if (!active) return;
    setLoading(true); setErr('');
    try {
      const payload = {
        answers: Object.entries(active.answers).map(([questionId, selected]) => ({ questionId, selected })),
      };
      const { data } = await api.post(`/mock/attempts/${active.attempt.id}/submit`, payload);
      setResult(data);
      setActive(null);
      await load();
    } catch (ex) {
      setErr(parseError(ex).message);
    } finally { setLoading(false); }
  };

  if (active) {
    const qs = active.questions || [];
    return (
      <div className="vision-tool">
        <h2>{active.attempt.title}</h2>
        <p className="muted">
          {qs.length} questions · {active.attempt.durationMin} min · {active.attempt.totalMarks} marks
        </p>
        {err && <div className="alert alert-error">{err}</div>}
        <div className="mock-questions">
          {qs.map((q, i) => (
            <div key={q.id} className="result-card" style={{ marginBottom: '1rem' }}>
              <strong>Q{q.orderIndex || i + 1}.</strong> {q.text}
              <div className="mock-options">
                {['A', 'B', 'C', 'D', 'E'].map((L) => {
                  const text = q[`option${L}`];
                  if (!text) return null;
                  return (
                    <label key={L} className={`mock-opt ${active.answers[q.id] === L ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name={q.id}
                        checked={active.answers[q.id] === L}
                        onChange={() => select(q.id, L)}
                      />
                      <span><b>{L}.</b> {text}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button className="btn btn-primary" disabled={loading} onClick={submit}>
          {loading ? 'Submitting…' : 'Submit & evaluate'}
        </button>
        <button className="btn btn-outline" style={{ marginLeft: 8 }} onClick={() => setActive(null)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="vision-tool">
      <h2>Conduct Mock Test</h2>
      <p className="muted">Start a generated paper, answer MCQs, submit for automatic evaluation against answer keys.</p>
      {err && <div className="alert alert-error">{err}</div>}

      {result && (
        <div className="result-card" style={{ marginBottom: '1.5rem' }}>
          <h3>{result.evaluated ? 'Result (evaluated)' : 'Submitted answers'}</h3>
          {result.evaluated ? (
            <p style={{ fontSize: '1.25rem' }}>
              <strong>{result.score}</strong> / {result.maxScore} &nbsp;
              ({result.percentage}%)
            </p>
          ) : (
            <p className="muted">{result.message || 'No answer key — only your selections are shown (not scored).'}</p>
          )}
          <details open>
            <summary>Review</summary>
            {result.answers?.map((a) => (
              <div key={a.id} style={{ margin: '0.75rem 0', paddingBottom: '0.75rem', borderBottom: '1px solid var(--line)' }}>
                <div>{a.question?.text}</div>
                <div className="muted">
                  Your answer: {a.selected || '— (skipped)'}
                  {result.evaluated && (
                    <>
                      {' '}· Correct: {a.question?.correctAnswer || '—'} ·{' '}
                      {a.isCorrect ? '✓' : a.selected ? '✗' : 'skipped'}
                    </>
                  )}
                </div>
              </div>
            ))}
          </details>
        </div>
      )}

      <div className="result-card">
        <h3>Available papers</h3>
        <table className="obj-table">
          <thead><tr><th>Title</th><th>Type</th><th>Qs</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {papers.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td>{p.type}</td>
                <td>{p.totalQuestions}</td>
                <td>{p.durationMin} min</td>
                <td>
                  <button className="btn btn-primary btn-sm" disabled={loading} onClick={() => start(p.id)}>
                    Start
                  </button>
                </td>
              </tr>
            ))}
            {!papers.length && <tr><td colSpan={5} className="muted">No papers yet — generate one from PYQ or Textbook first</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="result-card" style={{ marginTop: '1.5rem' }}>
        <h3>Your attempts</h3>
        <table className="obj-table">
          <thead><tr><th>Paper</th><th>Status</th><th>Score</th><th>When</th></tr></thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id}>
                <td>{a.paper?.title}</td>
                <td>{a.status}</td>
                <td>{a.score != null ? `${a.score} / ${a.maxScore}` : '—'}</td>
                <td>{new Date(a.startedAt).toLocaleString()}</td>
              </tr>
            ))}
            {!attempts.length && <tr><td colSpan={4} className="muted">No attempts yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
