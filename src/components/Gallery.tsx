"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The photo gallery on a property page.
 *
 * Every image is HOTLINKED from the portal, never copied to us. The photography
 * belongs to the agency; `og:image` and the gallery markup are published so
 * other sites can display them, and a link means a withdrawn property's photos
 * disappear on the portal's schedule rather than lingering on ours.
 *
 * Two consequences that shape this component:
 *
 *   1. Images can fail. A hotlink breaks when the portal moves a file, expires a
 *      CDN path, or refuses our referrer. A broken thumbnail in a strip of
 *      thirty looks like a bug in our product, so failures are dropped from the
 *      strip rather than shown as broken frames.
 *
 *   2. There is no preloading beyond the neighbours. Thirty full-size images
 *      from someone else's CDN is thirty requests we are making on their
 *      bandwidth for pictures nobody may look at.
 */
export function Gallery({ images, alt }: { images: string[]; alt: string }) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(false);

  const usable = images.filter((u) => !broken.has(u));
  const current = usable[Math.min(index, usable.length - 1)];

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = i + delta;
        if (next < 0) return usable.length - 1;
        if (next >= usable.length) return 0;
        return next;
      });
    },
    [usable.length],
  );

  /**
   * Stop the page scrolling behind the zoomed view.
   *
   * Without this, a scroll gesture over the overlay moves the page underneath,
   * so closing it drops you somewhere you never navigated to — which feels like
   * the app lost your place.
   */
  useEffect(() => {
    if (!zoom) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [zoom]);

  // Arrow keys, and Escape to leave the zoomed view. An agent flicking through
  // thirty photos should not have to aim at a small button each time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "Escape") setZoom(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (usable.length === 0) {
    return (
      <div className="no-photo flex aspect-[16/10] w-full items-center justify-center">
        <span className="text-[11px] uppercase tracking-widest text-[var(--color-faint)]">
          no photo
        </span>
      </div>
    );
  }

  const markBroken = (url: string) =>
    setBroken((prev) => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });

  return (
    <>
      {/*
        Height is capped; width always fills the card.

        The previous attempt set `max-height` on a box with a fixed aspect
        ratio, and CSS resolved that by shrinking the WIDTH to match — leaving a
        black gutter beside the photo inside a card that stayed full width. The
        cap has to be on height alone, with the image cropping to fill.

        Why cap at all: on a wide screen a 16:10 box across the column is most
        of the page, and the price, size and agency get pushed below the fold.
        Those are what somebody opened this page to read. The picture is
        context; the numbers are the product.
      */}
      <div
        className="group relative w-full bg-black"
        style={{ height: "clamp(300px, 44vh, 540px)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current}
          src={current}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => markBroken(current)}
          onClick={() => setZoom(true)}
          className="h-full w-full cursor-zoom-in object-cover"
        />

        {usable.length > 1 && (
          <>
            <Arrow side="left" onClick={() => go(-1)} />
            <Arrow side="right" onClick={() => go(1)} />
            <span className="tnum absolute bottom-3 right-3 rounded-md bg-black/70 px-2 py-1 text-[11px] text-white backdrop-blur">
              {index + 1} / {usable.length}
            </span>
          </>
        )}
      </div>

      {usable.length > 1 && (
        <div className="flex w-full min-w-0 gap-1.5 overflow-x-auto border-t border-[var(--color-line-soft)] p-2">
          {usable.map((url, i) => (
            <button
              key={url}
              onClick={() => setIndex(i)}
              aria-label={`Photo ${i + 1}`}
              className={
                "h-14 w-20 shrink-0 overflow-hidden rounded border transition-opacity " +
                (i === index
                  ? "border-[var(--color-accent-soft)] opacity-100"
                  : "border-[var(--color-line)] opacity-50 hover:opacity-90")
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => markBroken(url)}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {zoom && (
        /**
         * The zoomed view has to LOOK like a modal.
         *
         * The first version was a bare full-bleed image: no frame, no close
         * button, nothing to say what had happened. Clicking a photo and having
         * the page apparently replaced by a giant picture reads as a bug, not a
         * feature — so there is a visible header, a counter, an X, and the image
         * is contained inside a frame rather than filling every pixel.
         */
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-black/95 backdrop-blur-sm"
          onClick={() => setZoom(false)}
          role="dialog"
          aria-modal="true"
          aria-label={alt}
        >
          <div
            className="flex shrink-0 items-center justify-between px-6 py-4"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate pr-6 text-[13px] text-white/70">{alt}</span>
            <div className="flex items-center gap-4">
              <span className="tnum text-[12px] text-white/50">
                {index + 1} / {usable.length}
              </span>
              <button
                onClick={() => setZoom(false)}
                aria-label="Close"
                className="rounded-full border border-white/20 px-3 py-1 text-[12px] text-white/70 transition-colors hover:border-white/50 hover:text-white"
              >
                Close ✕
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={current}
              alt={alt}
              referrerPolicy="no-referrer"
              onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full rounded object-contain"
            />
          </div>

          <div className="shrink-0 pb-5 text-center text-[11px] text-white/40">
            ← → to move · Esc or click the backdrop to close
          </div>
        </div>
      )}
    </>
  );
}

function Arrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={
        "absolute top-1/2 -translate-y-1/2 rounded-full bg-black/60 px-3 py-2 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100 " +
        (side === "left" ? "left-3" : "right-3")
      }
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}
