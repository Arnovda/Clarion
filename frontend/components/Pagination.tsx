'use client';

/**
 * Reusable pagination controls for list views.
 * Works with the backend's paginated response envelope.
 */

interface PaginationProps {
  page: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGoTo?: (page: number) => void;
  total?: number;
  className?: string;
}

export default function Pagination({
  page,
  totalPages,
  hasNext,
  hasPrev,
  onPrev,
  onNext,
  onGoTo,
  total,
  className = '',
}: PaginationProps) {
  if (totalPages <= 1) return null;

  // Build page numbers to show (max 5 around current)
  const pages: number[] = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i++) pages.push(i);

  return (
    <div className={`flex items-center justify-between mt-4 ${className}`}>
      <div className="text-sm text-gray-500">
        {total !== undefined && (
          <span>Page {page} of {totalPages} ({total} total)</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onPrev}
          disabled={!hasPrev}
          className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Prev
        </button>
        {pages[0] > 1 && (
          <>
            <button
              onClick={() => onGoTo?.(1)}
              className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50"
            >
              1
            </button>
            {pages[0] > 2 && <span className="px-1 text-gray-400">...</span>}
          </>
        )}
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => onGoTo?.(p)}
            className={`px-2 py-1 text-sm rounded border ${
              p === page
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-gray-300 hover:bg-gray-50'
            }`}
          >
            {p}
          </button>
        ))}
        {pages[pages.length - 1] < totalPages && (
          <>
            {pages[pages.length - 1] < totalPages - 1 && (
              <span className="px-1 text-gray-400">...</span>
            )}
            <button
              onClick={() => onGoTo?.(totalPages)}
              className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50"
            >
              {totalPages}
            </button>
          </>
        )}
        <button
          onClick={onNext}
          disabled={!hasNext}
          className="px-3 py-1 text-sm rounded border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
