/**
 * Periodic-persistence helper for long batch operations (#5601).
 *
 * A folder import used to write `library.json` once, after every file was
 * done — killing the app mid-run lost the whole index while hundreds of book
 * dirs were already on disk, and each relaunch re-imported and re-accumulated
 * rows. This throttles full-index saves during the run so a crash loses at
 * most `intervalMs` of work:
 *
 *   - `touch()` after each unit of work: saves immediately on the first call,
 *     then at most once per `intervalMs`. Failures are logged and the state
 *     stays dirty so a later touch/flush retries.
 *   - `flush()` at the end: waits for any in-flight save, persists remaining
 *     dirty state, and propagates failure to the caller.
 *
 * Saves never overlap — the full-library serialization is expensive and
 * `safeSaveJSON` must not race itself.
 */
export interface ThrottledCheckpoint {
  touch(): void;
  flush(): Promise<void>;
}

export const createThrottledCheckpoint = (
  save: () => Promise<void>,
  intervalMs: number,
): ThrottledCheckpoint => {
  let dirty = false;
  let saving: Promise<void> | null = null;
  let lastStart = -Infinity;

  const runSave = () => {
    dirty = false;
    lastStart = Date.now();
    const current = save().finally(() => {
      if (saving === current) saving = null;
    });
    saving = current;
    return current;
  };

  return {
    touch() {
      dirty = true;
      if (!saving && Date.now() - lastStart >= intervalMs) {
        runSave().catch((error) => {
          dirty = true;
          console.warn('Checkpoint save failed; will retry on flush:', error);
        });
      }
    },
    async flush() {
      while (saving || dirty) {
        if (saving) {
          // Wait the in-flight save out, and re-dirty *here* if it failed
          // rather than relying on touch()'s own catch handler: that handler is
          // attached to the promise `runSave` derives from `.finally()`, so it
          // runs a microtask after the save settles — the loop can re-check and
          // exit before it does, and flush would then report success for a save
          // that failed. Re-dirtying in this handler makes the retry (and the
          // failure the caller sees) deterministic.
          const inFlight = saving;
          await inFlight.catch(() => {
            dirty = true;
          });
        } else {
          await runSave();
        }
      }
    },
  };
};
