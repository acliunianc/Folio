import { useEffect, useRef, useState } from "react";

export function WorkspaceRail({ names, current = null }: { names: string[]; current?: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const lastScroll = useRef(0);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const check = () => setOverflow(node.scrollWidth - node.clientWidth > 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(node);
    return () => observer.disconnect();
  }, [names]);

  function scroll(step: number) {
    const now = Date.now();
    if (now - lastScroll.current < 140) return;
    lastScroll.current = now;
    const node = scroller.current;
    if (node) node.scrollLeft += step;
  }

  function hit(target: Element | null) {
    if (!target || !root.current?.contains(target)) return;
    const edge = target.closest("[data-workspace-scroll]")?.getAttribute("data-workspace-scroll");
    if (edge === "prev" || edge === "next") scroll(edge === "prev" ? -36 : 36);
  }

  useEffect(() => {
    const move = (event: PointerEvent) => hit(document.elementFromPoint(event.clientX, event.clientY));
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  });

  const chevron = (edge: "prev" | "next", glyph: string) =>
    overflow ? (
      <span data-workspace-scroll={edge} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm text-white/80">
        {glyph}
      </span>
    ) : null;

  return (
    <div
      ref={root}
      data-workspace-bar
      className="pointer-events-auto flex h-11 max-w-[min(720px,86vw)] items-center gap-1 rounded-full bg-black/55 px-2 text-white"
    >
      {chevron("prev", "◀")}
      <div ref={scroller} data-workspace-scroller className="scroll-hidden flex min-w-0 gap-1 overflow-hidden">
        {names.map((name) => (
          <span
            key={name}
            data-workspace-name={name}
            className={`shrink-0 rounded-full px-3 py-1 text-sm ${name === current ? "bg-white/20 text-white" : "text-white/80"}`}
          >
            {name}
          </span>
        ))}
      </div>
      {chevron("next", "▶")}
    </div>
  );
}
