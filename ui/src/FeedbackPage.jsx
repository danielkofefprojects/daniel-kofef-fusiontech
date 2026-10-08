import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Badge } from './SubmitPage.jsx';

const STATUSES = ['', 'RECEIVED', 'ANALYZING', 'DONE', 'FAILED'];
const SENTIMENTS = ['', 'positive', 'neutral', 'negative'];
const PAGE_SIZES = [10, 20, 50];

function Analysis({ a }) {
  if (!a) return <span className="muted">—</span>;
  return (
    <div className="analysis">
      <div>
        <span className={`sent ${a.sentiment}`}>● {a.sentiment}</span>
      </div>
      <p>{a.actionable_insight}</p>
      {a.feature_requests.length > 0 && (
        <ul>
          {a.feature_requests.map((f, i) => (
            <li key={i}>
              {f.title} <span className="muted">({Math.round(f.confidence * 100)}%)</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function FeedbackPage() {
  const [status, setStatus] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(10);
  const [page, setPage] = useState(0);
  const [data, setData] = useState({ items: [], total: 0 });
  const [error, setError] = useState('');
  const [details, setDetails] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [retrying, setRetrying] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  // Only the most recent request may update the page, so a slow response
  // cannot overwrite a newer one (overlapping polls, filter changes).
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const qs = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
      if (status) qs.set('status', status);
      if (sentiment) qs.set('sentiment', sentiment);
      if (q) qs.set('q', q);
      const next = await api(`/feedback?${qs}`);
      if (requestId !== latestRequest.current) return;
      // Items may have been removed from the last page's range; step back.
      if (next.items.length === 0 && next.total > 0 && page > 0) {
        setPage(Math.ceil(next.total / limit) - 1);
        return;
      }
      setData(next);
      setError('');
      setLoaded(true);
      setUpdatedAt(new Date());
    } catch (e) {
      if (requestId === latestRequest.current) setError(e.message);
    }
  }, [status, sentiment, q, limit, page]);

  // Debounce the search box; any filter change returns to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Poll so status transitions show up without a manual refresh. Polling
  // pauses while the tab is hidden and catches up when it becomes visible.
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 2000);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Close the details dialog with Escape.
  useEffect(() => {
    if (!details) return undefined;
    const onKey = (e) => e.key === 'Escape' && setDetails(null);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [details]);

  async function retry(id) {
    setRetrying(id);
    try {
      await api(`/feedback/${id}/retry`, { method: 'POST' });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRetrying(null);
    }
  }

  const filtered = Boolean(status || sentiment || q);
  function clearFilters() {
    setStatus('');
    setSentiment('');
    setSearch('');
    setQ('');
    setPage(0);
  }

  async function showDetails(id) {
    try {
      setDetails(await api(`/feedback/${id}`));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card wide">
      <div className="row head">
        <div>
          <h1>Feedback <span className="count">{data.total}</span></h1>
          {updatedAt && <div className="muted small">Live · updated {updatedAt.toLocaleTimeString()}</div>}
        </div>
        <div className="toolbar">
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s || 'All statuses'}</option>
            ))}
          </select>
          <select value={sentiment} onChange={(e) => { setSentiment(e.target.value); setPage(0); }}>
            {SENTIMENTS.map((s) => (
              <option key={s} value={s}>{s || 'All sentiments'}</option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search content…"
            aria-label="Search content"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {filtered && <button onClick={clearFilters}>Clear filters</button>}
          <button onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <table>
        <thead>
          <tr><th>Content</th><th>Status</th><th>Analysis</th><th></th></tr>
        </thead>
        <tbody>
          {!loaded && !error && (
            <tr><td colSpan="4" className="muted center">Loading…</td></tr>
          )}
          {data.items.map((f) => (
            <tr key={f.id}>
              <td className="content">
                {f.content}
                <div className="muted small">{new Date(f.created_at).toLocaleString()}</div>
              </td>
              <td>
                <Badge status={f.status} />
                {f.last_error && <div className="err small">{f.last_error}</div>}
              </td>
              <td><Analysis a={f.analysis} /></td>
              <td className="actions">
                <button onClick={() => showDetails(f.id)}>Details</button>
                {f.status === 'FAILED' && (
                  <button className="primary" disabled={retrying === f.id} onClick={() => retry(f.id)}>
                    {retrying === f.id ? 'Retrying…' : 'Retry'}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {loaded && data.items.length === 0 && (
            <tr><td colSpan="4" className="muted center empty">{filtered ? 'No feedback matches the filters.' : 'No feedback yet.'}</td></tr>
          )}
        </tbody>
      </table>

      <div className="row pager">
        <span className="muted small">
          {data.total === 0 ? '0 results' : `${page * limit + 1}–${page * limit + data.items.length} of ${data.total}`}
        </span>
        <div>
          <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(0); }}>
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n} / page</option>
            ))}
          </select>
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </div>

      {details && (
        <div className="modal" onClick={() => setDetails(null)}>
          <div className="card" role="dialog" aria-modal="true" aria-label="Feedback details" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2>Details</h2>
              <button onClick={() => setDetails(null)}>Close</button>
            </div>
            <div className="muted small">{details.id} · {new Date(details.created_at).toLocaleString()}</div>
            {details.content && <blockquote>{details.content}</blockquote>}
            <details>
              <summary>Raw JSON</summary>
              <pre>{JSON.stringify(details, null, 2)}</pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
