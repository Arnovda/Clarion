'use client';

export interface Pill {
  key: string;
  label: string;
}

interface PillNavProps {
  pills: Pill[];
  activePill: string;
  onChange: (key: string) => void;
}

export default function PillNav({ pills, activePill, onChange }: PillNavProps) {
  if (pills.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {pills.map((pill) => (
        <button
          key={pill.key}
          onClick={() => onChange(pill.key)}
          className={`
            px-3.5 py-1.5 rounded-full text-[12px] font-medium transition-colors duration-150
            ${pill.key === activePill
              ? 'bg-ocean-softer text-ocean'
              : 'bg-transparent text-muted hover:bg-softer hover:text-ink-2'
            }
          `}
        >
          {pill.label}
        </button>
      ))}
    </div>
  );
}
