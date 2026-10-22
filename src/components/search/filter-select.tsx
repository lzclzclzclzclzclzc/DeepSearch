"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@/components/icons";
import styles from "./filter-select.module.css";

export function FilterSelect({ label, value, options, icon, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; icon: IconName; onChange: (value: string) => void;
}) {
  const id = useId(); const root = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false); const [active, setActive] = useState(0);
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)?.focus(); }, [open, active]);
  function choose(index: number) { setOpen(false); trigger.current?.focus(); onChange(options[index].value); }
  function keydown(event: KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Home", "End", "Escape"].includes(event.key)) event.preventDefault();
    if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    else if (event.key === "Tab") setOpen(false);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(options.length - 1);
    else if (event.key === "ArrowDown") { setOpen(true); setActive(open ? (active + 1) % options.length : selected); }
    else if (event.key === "ArrowUp") { setOpen(true); setActive(open ? (active - 1 + options.length) % options.length : selected); }
  }
  return <div ref={root} className={styles.root} onKeyDown={keydown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className={styles.trigger} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { setActive(selected); setOpen(!open); }}>
      <Icon name={icon} size={16}/><span>{options[selected].label}</span><Icon name="chevron" size={12} style={{ transform: open ? "rotate(-90deg)" : "rotate(90deg)" }}/>
    </button>
    {open && <div className={styles.menu} id={id} role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.value} type="button" role="option" aria-selected={index === selected} tabIndex={index === active ? 0 : -1} data-index={index} onClick={() => choose(index)} className={styles.option}>
        <span>{option.label}</span>{index === selected && <Icon name="check" size={15}/>}
      </button>)}
    </div>}
  </div>;
}
