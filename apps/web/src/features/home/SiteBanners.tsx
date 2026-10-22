import { useLayoutEffect, useRef, useState } from "react";
import { siteConfig } from "@/app/site-config";
import { attachBannerRotation } from "./banner-rotation";

export default function SiteBanners() {
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const banners = siteConfig.banners.map((banner, index) => ({ banner, index })).filter(({ index }) => !failed.has(index));
  useLayoutEffect(() => {
    if (banners.length < 2 || !viewport.current || !surface.current) return;
    return attachBannerRotation(viewport.current, surface.current);
  }, [banners.length]);
  if (banners.length === 0) return null;
  const slides = banners.length > 1 ? [...banners, ...banners, ...banners] : banners;
  return (
    <div className="site-banner-carousel" ref={surface}>
      <div className={`site-banners${banners.length > 1 ? " site-banners-multiple" : ""}`} ref={viewport}>
        {slides.map(({ banner, index }, position) => (
          <a className="site-banner" href={banner.href} key={`${banner.image}:${banner.href}:${index}:${position}`}
            data-banner-clone={(position < banners.length || position >= banners.length * 2) && banners.length > 1 ? "true" : undefined}
            aria-hidden={(position < banners.length || position >= banners.length * 2) && banners.length > 1 ? true : undefined}
            tabIndex={(position < banners.length || position >= banners.length * 2) && banners.length > 1 ? -1 : undefined}>
            <img src={banner.image} alt={banner.alt} decoding="async"
              onError={() => setFailed(current => new Set(current).add(index))} />
          </a>
        ))}
      </div>
    </div>
  );
}
