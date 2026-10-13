import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { parseError, downloadFile } from '../api/client';
import Avatar from '../components/Avatar';

const PAGE_SIZES = [10, 25, 50];
const TEMPLATE = 'name,email,phone,role,password\nJane Doe,jane@example.com,+911234567890,USER,\n';

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'user';

function pageList(page, total) {
  const nums = [...new Set([1, total, page - 1, page, page + 1])].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push(`gap-${n}`);
    out.push(n);
  });
  return out;
}

function Pagination({ page, totalPages, total, limit, onPage, onLimit }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className="pagination">
      <p className="muted-sm">Showing {from}–{to} of {total}</p>
      <div className="pager" role="navigation" aria-label="Pagination">
        <button className="btn btn-outline btn-sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous</button>
        {pageList(page, totalPages).map((n) =>
          typeof n === 'string' ? <span key={n} className="gap">…</span> : (
            <button key={n} className={`btn btn-sm ${n === page ? 'btn-primary' : 'btn-outline'}`} onClick={() => onPage(n)}
              aria-current={n === page ? 'page' : undefined}>{n}</button>
          )
        )}
        <button className="btn btn-outline btn-sm" onClick={() => onPage(page + 1)} disabled={page >= totalPages}>Next</button>
      </div>
      <label className="per-page">
        Rows
        <select value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

export default function Users() {
  const [params, setParams] = useState({ page: 1, limit: 10, search: '', role: '' });
  const [searchInput, setSearchInput] = useState('');
  const [result, setResult] = useState({ data: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  const latest = useRef(0);

  // Search as you type, but wait for a short pause before asking the server.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = searchInput.trim();
      setParams((p) => (p.search === q ? p : { ...p, search: q, page: 1 }));
    }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const id = ++latest.current; // ignore out-of-order responses
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/users', { params });
      if (id === latest.current) setResult(res.data);
    } catch (err) {
      if (id === latest.current) setError(parseError(err).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  const setPage = (page) => setParams((p) => ({ ...p, page }));
  const setLimit = (limit) => setParams((p) => ({ ...p, limit, page: 1 }));
  const setRole = (role) => setParams((p) => ({ ...p, role, page: 1 }));

  const run = async (fn) => {
    setNotice('');
    setError('');
    try { await fn(); } catch (err) { setError(err.message); }
  };

  const exportCsv = () => run(() => downloadFile('/users/export', { search: params.search, role: params.role }, 'users.csv'));
  const exportPdf = (u) => run(() => downloadFile(`/users/${u.id}/pdf`, {}, `profile-${slug(u.name)}.pdf`));

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'users-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // lets you pick the same file again
    if (!file) return;
    setNotice('');
    setError('');
    setImportResult(null);
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.post('/users/import', form);
      setImportResult(res.data);
      setParams((p) => ({ ...p, page: 1 }));
      load();
    } catch (err) {
      setError(parseError(err).message);
    } finally {
      setImporting(false);
    }
  };

  const { data, total, totalPages } = result;
  const filtered = params.search || params.role;

  return (
    <section className="page wide">
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <p className="muted">{total} {total === 1 ? 'user' : 'users'}{filtered ? ' match your filters' : ' in total'}</p>
        </div>
        <Link className="btn btn-primary" to="/users/new">Add user</Link>
      </div>

      <div className="toolbar">
        <input className="search" type="search" placeholder="Search by name, email or phone" aria-label="Search users"
          value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select aria-label="Filter by role" value={params.role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option>
          <option value="ADMIN">Administrators</option>
          <option value="USER">Members</option>
        </select>
        <div className="toolbar-actions">
          <button className="btn btn-outline" onClick={() => fileRef.current.click()} disabled={importing}>{importing ? 'Importing…' : 'Import CSV'}</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} hidden />
          <button className="btn btn-outline" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>
      <p className="muted-sm import-hint">
        Importing? Use columns <code>name, email, phone, role, password</code> (only name and email are required). <button className="link-btn" onClick={downloadTemplate}>Download template</button>
      </p>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {importResult && (
        <div className="import-result" role="status">
          <div className="import-head">
            <strong>Import finished</strong>
            <button className="link-btn" onClick={() => setImportResult(null)}>Dismiss</button>
          </div>
          <p>
            <span className="ok">{importResult.created} added</span>
            {' · '}{importResult.skipped.length} skipped (already exist)
            {' · '}<span className={importResult.failed.length ? 'bad' : ''}>{importResult.failed.length} failed</span>
          </p>
          {importResult.created > 0 && <p className="muted-sm">New users without a password can use “Forgot password” on the sign-in page to set one.</p>}
          {importResult.failed.length > 0 && (
            <div className="table-wrap small">
              <table className="table">
                <thead><tr><th>Row</th><th>Email</th><th>Problem</th></tr></thead>
                <tbody>
                  {importResult.failed.slice(0, 20).map((f) => (
                    <tr key={f.row}><td>{f.row}</td><td>{f.email || '—'}</td><td>{f.reason}</td></tr>
                  ))}
                </tbody>
              </table>
              {importResult.failed.length > 20 && <p className="muted-sm">Showing the first 20 of {importResult.failed.length}.</p>}
            </div>
          )}
        </div>
      )}

      <div className={`table-wrap ${loading ? 'is-loading' : ''}`}>
        <table className="table responsive">
          <thead>
            <tr><th>User</th><th>Phone</th><th>Role</th><th>Status</th><th>Joined</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td data-label="User">
                  <div className="user-cell">
                    <Avatar user={u} size={36} />
                    <div><div className="user-name">{u.name}</div><div className="muted-sm">{u.email}</div></div>
                  </div>
                </td>
                <td data-label="Phone">{u.phone || '—'}</td>
                <td data-label="Role"><span className={`badge ${u.role === 'ADMIN' ? 'badge-admin' : ''}`}>{u.role === 'ADMIN' ? 'Admin' : 'Member'}</span></td>
                <td data-label="Status"><span className={`badge ${u.isVerified ? 'badge-ok' : 'badge-warn'}`}>{u.isVerified ? 'Verified' : 'Unverified'}</span></td>
                <td data-label="Joined">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="row-actions">
                  <Link className="btn btn-outline btn-sm" to={`/users/${u.id}/edit`}>Edit</Link>
                  <button className="btn btn-outline btn-sm" onClick={() => exportPdf(u)}>PDF</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && data.length === 0 && (
          <div className="empty">
            {filtered ? (
              <>
                <p>No users match your search.</p>
                <button className="btn btn-outline" onClick={() => { setSearchInput(''); setParams((p) => ({ ...p, search: '', role: '', page: 1 })); }}>Clear filters</button>
              </>
            ) : (
              <p>No users yet. Add one or import a CSV to get started.</p>
            )}
          </div>
        )}
      </div>

      {total > 0 && <Pagination page={params.page} totalPages={totalPages} total={total} limit={params.limit} onPage={setPage} onLimit={setLimit} />}
    </section>
  );
}
