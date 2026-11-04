"use client";

import { useEffect, useState } from "react";

const VIDEO_SRC = "/rednest-hero.mp4";
const POSTER_SRC = "/rednest-hero-poster.jpg";

/**
 * Homepage / claim hero panel. Plays the RedNest hero loop when motion is
 * allowed; otherwise shows a static poster from the same video.
 */
export function ChestStage() {
  const [motion, setMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotion(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  return (
    <div className="chest-stage" data-chest-stage="" data-canvas="ready">
      <div className="scene scene-hero">
        {motion ? (
          <video
            className="scene-media"
            src={VIDEO_SRC}
            poster={POSTER_SRC}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden="true"
          />
        ) : (
          <img className="scene-media" src={POSTER_SRC} alt="" decoding="async" />
        )}
      </div>
    </div>
  );
}
