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
  const [prolongedSleep, setProlongedSleep] = useState(false);
  const [windowFocused, setWindowFocused] = useState(
    () => typeof document !== "undefined" && document.hasFocus ? document.hasFocus() : true,
  );

  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Track window focus/blur to pause decoding when unfocused
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = mode;
    setProlongedSleep(false);
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
      setProlongedSleep(false);
      if (attention && mode === "normal") setClip("curious-bounce");
    }
  }, [attention, mode]);

  // When resting in sleep clip for > 8s, throttle to static image frame to cut CPU/GPU decoding
  useEffect(() => {
    if (clip !== "sleep") {
      setProlongedSleep(false);
      return;
    }
    const timer = setTimeout(() => {
      setProlongedSleep(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, [clip]);

  useEffect(() => {
    setFailed(false);
    const player = video.current;
    let active = true;
    const sync = () => {
      if (document.hidden || !windowFocused || reduced || prolongedSleep) {
        player?.pause();
      } else {
        void player?.play().catch(() => {
          if (active) setFailed(true);
        });
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", sync);
      player?.pause();
    };
  }, [clip, reduced, windowFocused, prolongedSleep]);

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
      {reduced || failed || prolongedSleep ? (
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
