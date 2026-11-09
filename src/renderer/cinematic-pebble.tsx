import React, { useEffect, useRef, useState } from "react";
import type { CompanionMode } from "../shared/types";
import {
  PEBBLE_MOTION_KEY,
  parsePebbleMotion,
  pebbleLoops,
  pebbleQuality,
  type PebbleClip,
  type PebbleMotion,
} from "../shared/pebble";

// Literal URLs let Vite fingerprint and bundle these assets in dev and packaged builds.
const media: Record<PebbleClip, { full: string; lite: string; still: string }> =
  {
    idle: {
      full: new URL("../../assets/companion/pebble/idle.webm", import.meta.url)
        .href,
      lite: new URL(
        "../../assets/companion/pebble/idle-lite.webm",
        import.meta.url,
      ).href,
      still: new URL("../../assets/companion/pebble/idle.png", import.meta.url)
        .href,
    },
    "doze-off": {
      full: new URL(
        "../../assets/companion/pebble/doze-off.webm",
        import.meta.url,
      ).href,
      lite: new URL(
        "../../assets/companion/pebble/doze-off-lite.webm",
        import.meta.url,
      ).href,
      still: new URL(
        "../../assets/companion/pebble/doze-off.png",
        import.meta.url,
      ).href,
    },
    sleep: {
      full: new URL("../../assets/companion/pebble/sleep.webm", import.meta.url)
        .href,
      lite: new URL(
        "../../assets/companion/pebble/sleep-lite.webm",
        import.meta.url,
      ).href,
      still: new URL("../../assets/companion/pebble/sleep.png", import.meta.url)
        .href,
    },
    "curious-bounce": {
      full: new URL(
        "../../assets/companion/pebble/curious-bounce.webm",
        import.meta.url,
      ).href,
      lite: new URL(
        "../../assets/companion/pebble/curious-bounce-lite.webm",
        import.meta.url,
      ).href,
      still: new URL(
        "../../assets/companion/pebble/curious-bounce.png",
        import.meta.url,
      ).href,
    },
    "drag-left": {
      full: new URL(
        "../../assets/companion/pebble/drag-left.webm",
        import.meta.url,
      ).href,
      lite: new URL(
        "../../assets/companion/pebble/drag-left-lite.webm",
        import.meta.url,
      ).href,
      still: new URL(
        "../../assets/companion/pebble/drag-left.png",
        import.meta.url,
      ).href,
    },
    "drag-right": {
      full: new URL(
        "../../assets/companion/pebble/drag-right.webm",
        import.meta.url,
      ).href,
      lite: new URL(
        "../../assets/companion/pebble/drag-right-lite.webm",
        import.meta.url,
      ).href,
      still: new URL(
        "../../assets/companion/pebble/drag-right.png",
        import.meta.url,
      ).href,
    },
    "release-settle": {
      full: new URL(
        "../../assets/companion/pebble/release-settle.webm",
        import.meta.url,
      ).href,
      lite: new URL(
        "../../assets/companion/pebble/release-settle-lite.webm",
        import.meta.url,
      ).href,
      still: new URL(
        "../../assets/companion/pebble/release-settle.png",
        import.meta.url,
      ).href,
    },
  };

function useMotion() {
  const [setting, setSetting] = useState(() => {
    try {
      return parsePebbleMotion(localStorage.getItem(PEBBLE_MOTION_KEY));
    } catch {
      return "auto" as PebbleMotion;
    }
  });
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      try {
        setSetting(parsePebbleMotion(localStorage.getItem(PEBBLE_MOTION_KEY)));
      } catch {
        /* Keep the session preference if storage is unavailable. */
      }
    };
    const change = () => setReduced(query.matches);
    window.addEventListener("storage", sync);
    window.addEventListener("pebble-motion-change", sync);
    query.addEventListener("change", change);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("pebble-motion-change", sync);
      query.removeEventListener("change", change);
    };
  }, []);
  const update = (value: PebbleMotion) => {
    setSetting(value);
    try {
      localStorage.setItem(PEBBLE_MOTION_KEY, value);
    } catch {
      /* Session-only setting. */
    }
    window.dispatchEvent(new Event("pebble-motion-change"));
  };
  return {
    setting,
    update,
    quality: pebbleQuality(setting, reduced, navigator.hardwareConcurrency),
  };
}

export function PebbleMotionSettings() {
  const { setting, update } = useMotion();
  return (
    <label>
      Pebble animation
      <select
        aria-label="Pebble animation"
        value={setting}
        onChange={(e) => update(e.target.value as PebbleMotion)}
      >
        <option value="auto">Auto · adapt to this device</option>
        <option value="full">Full motion</option>
        <option value="lite">Lite motion</option>
        <option value="off">Off · still Pebble</option>
      </select>
    </label>
  );
}

export function Pebble({
  mode,
  direction,
  greeting,
}: {
  mode: CompanionMode;
  direction: "left" | "right";
  greeting: number;
}) {
  const { quality } = useMotion();
  const [clip, setClip] = useState<PebbleClip>(
    mode === "idle" ? "doze-off" : "idle",
  );
  const [visible, setVisible] = useState(!document.hidden);
  const [failed, setFailed] = useState<string | null>(null);
  const previous = useRef(mode);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  useEffect(() => {
    const before = previous.current;
    previous.current = mode;
    if (mode === "dragging")
      setClip(direction === "left" ? "drag-left" : "drag-right");
    else if (mode === "idle") setClip("doze-off");
    else if (before === "dragging") setClip("release-settle");
    else if (before === "idle") setClip("curious-bounce");
    else setClip("idle");
  }, [mode]);
  useEffect(() => {
    if (mode === "dragging")
      setClip(direction === "left" ? "drag-left" : "drag-right");
  }, [direction, mode]);
  useEffect(() => {
    if (greeting && mode === "normal") setClip("curious-bounce");
  }, [greeting]);
  const source = quality === "off" ? "" : media[clip][quality];
  const animate = quality !== "off" && visible && failed !== source;
  useEffect(() => {
    if (!animate) return;
    const element = video.current;
    if (!element) return;
    let disposed = false;
    void element.play().catch((error: unknown) => {
      if (
        !disposed &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        setFailed(source);
    });
    return () => {
      disposed = true;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [animate, source]);
  const stillClip =
    mode === "idle" ? "sleep" : mode === "dragging" ? clip : "idle";
  const still = media[stillClip].still;
  return animate ? (
    <video
      key={source}
      ref={video}
      className="pebble-media"
      data-pebble-state={clip}
      src={source}
      poster={media[clip].still}
      muted
      playsInline
      autoPlay
      loop={pebbleLoops(clip)}
      preload="auto"
      aria-hidden="true"
      onError={(event) => {
        if (event.currentTarget.isConnected) setFailed(source);
      }}
      onEnded={() => setClip(mode === "idle" ? "sleep" : "idle")}
    />
  ) : (
    <img
      className="pebble-media"
      data-pebble-state={stillClip}
      src={still}
      alt=""
      draggable={false}
    />
  );
}
