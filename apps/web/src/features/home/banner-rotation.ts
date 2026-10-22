const ROTATION_DELAY_MS = 5_000;

/** Three sets of slides leave room to swipe either way, including the mobile peek. */
export function attachBannerRotation(viewport: HTMLElement, surface: HTMLElement): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const slides = Array.from(viewport.querySelectorAll<HTMLElement>(".site-banner"));
  const originals = slides.filter(slide => !slide.hasAttribute("data-banner-clone"));
  if (originals.length < 2) return () => {};
  const position = (slide: HTMLElement) => slide.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft;
  const nearest = () => slides.reduce((best, slide) =>
    Math.abs(position(slide) - viewport.scrollLeft) < Math.abs(position(best) - viewport.scrollLeft) ? slide : best);
  const originalFor = (slide: HTMLElement) => originals[slides.indexOf(slide) % originals.length];
  let timer: number | undefined;
  let settleTimer: number | undefined;
  let hovering = false;
  let dragging = false;
  let disposed = false;
  let visible = typeof IntersectionObserver === "undefined";
  const clear = () => window.clearTimeout(timer);
  const normalizeLoop = () => {
    if (dragging) return;
    const current = nearest();
    if (current.hasAttribute("data-banner-clone") && Math.abs(position(current) - viewport.scrollLeft) < 2)
      viewport.scrollTo({ left: position(originalFor(current)), behavior: "instant" });
  };
  // Start in the middle set before paint; the first banner has a previous neighbor.
  viewport.scrollTo({ left: position(originals[0]), behavior: "instant" });
  const schedule = () => {
    clear();
    if (disposed || !visible || document.hidden || reducedMotion.matches || hovering || dragging || surface.contains(document.activeElement)) return;
    timer = window.setTimeout(() => {
      normalizeLoop();
      const next = slides[slides.indexOf(nearest()) + 1];
      if (next) viewport.scrollTo({ left: position(next), behavior: "smooth" });
      schedule();
    }, ROTATION_DELAY_MS);
  };
  const onScroll = () => {
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { normalizeLoop(); schedule(); }, 150);
    schedule();
  };
  const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
    schedule();
  });
  observer?.observe(surface);
  const focusOut = () => { clear(); timer = window.setTimeout(schedule, 0); };
  const enter = (event: PointerEvent) => { if (event.pointerType === "mouse") { hovering = true; clear(); } };
  const leave = () => { hovering = false; schedule(); };
  const down = () => { dragging = true; clear(); };
  const up = () => { if (dragging) { dragging = false; normalizeLoop(); schedule(); } };
  surface.addEventListener("pointerenter", enter);
  surface.addEventListener("pointerleave", leave);
  surface.addEventListener("pointerdown", down);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  surface.addEventListener("focusin", clear);
  surface.addEventListener("focusout", focusOut);
  viewport.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", schedule);
  schedule();
  return () => {
    disposed = true;
    clear();
    window.clearTimeout(settleTimer);
    observer?.disconnect();
    surface.removeEventListener("pointerenter", enter);
    surface.removeEventListener("pointerleave", leave);
    surface.removeEventListener("pointerdown", down);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    surface.removeEventListener("focusin", clear);
    surface.removeEventListener("focusout", focusOut);
    viewport.removeEventListener("scroll", onScroll);
    document.removeEventListener("visibilitychange", schedule);
    reducedMotion.removeEventListener("change", schedule);
  };
}
