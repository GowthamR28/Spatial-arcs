import { useFlowStore } from '../store/useFlowStore';

export async function connectToBackend(url: string) {
  const store = useFlowStore.getState();
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    store.setApiBase(null);
    store.setBackendMode(false);
    store.setApiStatus('local');
    return;
  }
  store.setApiStatus('connecting');
  try {
    const r = await fetch(trimmed + '/api/health');
    if (!r.ok) throw new Error('bad status');
    await r.json();
    store.setApiBase(trimmed);
    store.setBackendMode(true);
    store.setApiStatus('connected');
  } catch {
    store.setApiBase(null);
    store.setBackendMode(false);
    store.setApiStatus('error');
  }
}

export async function uploadToBackend(file: File) {
  const store = useFlowStore.getState();
  store.setApiStatus('uploading');
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch(store.apiBase + '/api/datasets', { method: 'POST', body: fd });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ detail: 'upload failed' }));
      throw new Error(e.detail || 'upload failed');
    }
    const data = await r.json();
    store.setDatasetId(data.dataset_id);
    const topN = Math.min(300, data.n_edges);
    store.setTopN(topN);
    useFlowStore.setState({ maxTopN: Math.min(data.n_edges, 20000) });
    store.setApiStatus('connected');
    await fetchFlowsFromBackend();
  } catch (err) {
    store.setApiStatus('upload-failed');
    alert('Backend upload failed: ' + (err as Error).message);
  }
}

export async function fetchFlowsFromBackend() {
  const store = useFlowStore.getState();
  if (!store.apiBase || !store.datasetId) return;
  const url = `${store.apiBase}/api/datasets/${store.datasetId}/flows?top_n=${store.topN}&max_nodes=${store.maxNodesServer}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    store.ingestAggregated(d.nodes, d.edges, d);
  } catch (err) {
    console.error('flow fetch failed', err);
  }
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let h: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  }) as T;
}

export const debouncedServerFetch = debounce(fetchFlowsFromBackend, 400);
