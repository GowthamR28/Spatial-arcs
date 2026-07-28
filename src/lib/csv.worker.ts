/// <reference lib="webworker" />
import { aggregateCSV } from './csv';

export interface WorkerRequest {
  text: string;
}

export type WorkerResponse =
  | { type: 'done'; nodes: ReturnType<typeof aggregateCSV>['nodes']; edges: ReturnType<typeof aggregateCSV>['edges'] }
  | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const { nodes, edges } = aggregateCSV(e.data.text);
    const response: WorkerResponse = { type: 'done', nodes, edges };
    (self as unknown as Worker).postMessage(response);
  } catch (err) {
    const response: WorkerResponse = { type: 'error', message: (err as Error).message || 'Failed to parse CSV.' };
    (self as unknown as Worker).postMessage(response);
  }
};
