import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `load` whenever `key` changes, clearing stale data. A new `version`
 * or a `reload()` re-runs it in place, keeping the last data on screen.
 */
export function useAsync<T>(load: () => Promise<T>, key: string | null, version = 0): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(key !== null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (key === null) {
      setData(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (lastKey.current !== key) setData(undefined);
    lastKey.current = key;
    setLoading(true);
    setError(null);
    loadRef.current().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, nonce, version]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}
