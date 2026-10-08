export async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const details = Array.isArray(data?.details) ? ` (${data.details.join('; ')})` : '';
    throw new Error(`${data?.error ?? `Request failed with ${res.status}`}${details}`);
  }
  return data;
}
