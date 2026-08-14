import { gunzipSync } from 'fflate';

const workerContext: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerContext.onmessage = (event: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => {
  const { id, buffer } = event.data;
  try {
    const data = gunzipSync(new Uint8Array(buffer));
    workerContext.postMessage({ id, data: data.buffer }, [data.buffer]);
  } catch (error) {
    workerContext.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
