import { useEffect, useId, useState, type KeyboardEvent } from "react";

export interface AutomationSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface AutomationSelectProps<T extends string | number> {
  ariaLabel: string;
  value: T;
  options: AutomationSelectOption<T>[];
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: T) => void;
}

export function AutomationSelect<T extends string | number>({
  ariaLabel,
  value,
  options,
  disabled = false,
  open,
  onOpenChange,
  onChange,
}: AutomationSelectProps<T>) {
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (open) setHighlightedIndex(selectedIndex);
  }, [open, selectedIndex]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    onOpenChange(false);
  };

  const move = (direction: 1 | -1) => {
    if (!open) {
      onOpenChange(true);
      return;
    }
    setHighlightedIndex((current) => (current + direction + options.length) % options.length);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(highlightedIndex);
      else onOpenChange(true);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  return (
    <div className={`automation-select${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="automation-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? ""}</span>
        <span className="automation-select-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={listboxId} className="automation-select-listbox" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              className={`automation-select-option${index === highlightedIndex ? " is-highlighted" : ""}`}
              role="option"
              aria-selected={option.value === value}
              onPointerEnter={() => setHighlightedIndex(index)}
              onClick={() => choose(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
