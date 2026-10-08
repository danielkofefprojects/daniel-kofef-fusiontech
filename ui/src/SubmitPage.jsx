import { useState } from 'react';
import { api } from './api.js';

const MAX_LENGTH = 5000; // keep in sync with MAX_CONTENT_LENGTH in src/routes.ts

export default function SubmitPage() {
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api('/feedback', { method: 'POST', body: JSON.stringify({ content }) }));
      setContent('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>Submit feedback</h1>
      <p className="muted">Analysis runs asynchronously after submission.</p>
      <form onSubmit={submit}>
        <textarea
          rows={6}
          value={content}
          maxLength={MAX_LENGTH}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Tell us what you think..."
        />
        <div className="row">
          <span className="muted">{content.length} / {MAX_LENGTH}</span>
          <button className="primary" disabled={busy || !content.trim()}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>

      {error && <div className="alert error">{error}</div>}
      {result && (
        <div className={`alert ${result.duplicate ? 'warn' : 'ok'}`}>
          {result.duplicate ? 'Duplicate of an existing item.' : 'Feedback received.'} ID: {result.id} · Status:{' '}
          <Badge status={result.status} /> · <a href="#/feedback">View all feedback →</a>
        </div>
      )}
    </div>
  );
}

export function Badge({ status }) {
  return <span className={`badge ${status}`}>{status}</span>;
}
