import { useEffect, useRef, useState } from "react";
import { onLocalChange } from "../offline/db";

/** Load data from IndexedDB and reload it whenever local data changes (writes or sync). */
export function useLocal<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: unknown }>({ data: undefined, error: null });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => onLocalChange(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let live = true;
    fnRef.current().then(
      (data) => live && setState({ data, error: null }),
      (error: unknown) => live && setState((s) => ({ data: s.data, error })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
