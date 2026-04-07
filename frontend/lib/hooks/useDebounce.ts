/**
 * useDebounce — debounce a value or callback for search inputs, filters, etc.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

/**
 * Returns a debounced version of `value` that only updates after `delay` ms of inactivity.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Returns a debounced callback that fires at most once every `delay` ms.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay = 300,
): (...args: Args) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (...args: Args) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => callbackRef.current(...args), delay);
    },
    [delay],
  );
}

/**
 * Pagination hook for list endpoints that return { data, pagination } envelopes.
 */
export function usePagination(initialLimit = 50) {
  const [page, setPage] = useState(1);
  const [limit] = useState(initialLimit);
  const [total, setTotal] = useState(0);

  const totalPages = useMemo(() => Math.ceil(total / limit) || 1, [total, limit]);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  const nextPage = useCallback(() => {
    if (hasNext) setPage((p) => p + 1);
  }, [hasNext]);

  const prevPage = useCallback(() => {
    if (hasPrev) setPage((p) => p - 1);
  }, [hasPrev]);

  const goToPage = useCallback(
    (p: number) => setPage(Math.max(1, Math.min(p, totalPages))),
    [totalPages],
  );

  return { page, limit, total, totalPages, hasNext, hasPrev, setTotal, nextPage, prevPage, goToPage, setPage };
}
