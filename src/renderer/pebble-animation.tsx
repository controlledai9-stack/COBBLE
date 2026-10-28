import React, { useEffect, useRef, useState } from "react";
import type { CompanionMode } from "../shared/types";
import { pebbleClips } from "./pebble-clips";

type Clip = keyof typeof pebbleClips;

export function PebbleAnimation({
  mode,
  direction = "right",
  attention,
}: {
  mode: CompanionMode;
  direction?: "left" | "right";
  attention?: string;
}) {
  const [clip, setClip] = useState<Clip>(mode === "idle" ? "sleep" : "idle");
  const previous = useRef(mode);
  const lastAttention = useRef(attention);
  const video = useRef<HTMLVideoElement>(null);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = mode;
    if (mode === "dragging") {
      setClip(before === "dragging" ? `drag-${direction}` : "elastic-swoop");
    } else if (mode === "idle") {
      setClip(before === "idle" ? "sleep" : "doze-off");
    } else if (before === "dragging") {
      setClip("release-settle");
    } else if (before !== mode) {
      setClip("idle");
    }
  }, [mode, direction]);

  useEffect(() => {
    if (attention !== lastAttention.current) {
      lastAttention.current = attention;
      if (attention && mode === "normal") setClip("curious-bounce");
    }
  }, [attention, mode]);

  useEffect(() => {
    setFailed(false);
    const player = video.current;
    let active = true;
    const sync = () => {
      if (document.hidden || reduced) player?.pause();
      else
        void player?.play().catch(() => {
          if (active) setFailed(true);
        });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", sync);
      player?.pause();
    };
  }, [clip, reduced]);

  const asset = pebbleClips[clip];
  return (
    <div
      className="pebble-companion-root pebble-motion"
      data-animation={clip}
      aria-hidden="true"
    >
      {/* A fixed coordinate plane preserves the pointer's grab point across clips. */}
      <svg
        className="pebble-grab-plane"
        width="110"
        height="100"
        viewBox="0 0 200 194"
      >
        <g className="pebble-main-pod">
          <rect width="200" height="194" fill="transparent" />
        </g>
      </svg>
      {reduced || failed ? (
        <img
          className="pebble-motion-media"
          src={asset.still}
          alt=""
          draggable={false}
        />
      ) : (
        <video
          key={clip}
          ref={video}
          className="pebble-motion-media"
          src={asset.video}
          poster={asset.still}
          autoPlay
          muted
          playsInline
          loop={asset.loop}
          preload="auto"
          onError={() => setFailed(true)}
          onEnded={() =>
            setClip(
              mode === "idle"
                ? "sleep"
                : mode === "dragging"
                  ? `drag-${direction}`
                  : "idle",
            )
          }
        />
      )}
    </div>
  );
}
