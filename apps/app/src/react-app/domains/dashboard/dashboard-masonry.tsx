/** @jsxImportSource react */
import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Coarse tracks stay below browser implicit-grid limits even for 50 tall Apps.
const ROW_HEIGHT = 8;
const GAP = 8;

/** Keep DOM/keyboard order and mounted Apps stable while CSS packs variable-height tiles. */
export function DashboardMasonry({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] items-start gap-x-2"
      style={{ gridAutoRows: `${ROW_HEIGHT}px` }}
      data-dashboard-masonry
    >
      {Children.map(children, (child) => <MasonryItem>{child}</MasonryItem>)}
    </div>
  );
}

function MasonryItem({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(1);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setRows(Math.max(1, Math.ceil((node.getBoundingClientRect().height + GAP) / ROW_HEIGHT)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="min-w-0 self-start" style={{ gridRowEnd: `span ${rows}` }} data-dashboard-masonry-item>
      {children}
    </div>
  );
}
