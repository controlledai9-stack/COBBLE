export const pebbleClips = {
  idle: {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/idle.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/idle.png",
      import.meta.url,
    ).href,
    loop: true,
  },
  "doze-off": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/doze-off.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/doze-off.png",
      import.meta.url,
    ).href,
    loop: false,
  },
  sleep: {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/sleep.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/sleep.png",
      import.meta.url,
    ).href,
    loop: true,
  },
  "curious-bounce": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/curious-bounce.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/curious-bounce.png",
      import.meta.url,
    ).href,
    loop: false,
  },
  "drag-right": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/drag-right.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/drag-right.png",
      import.meta.url,
    ).href,
    loop: true,
  },
  "drag-left": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/drag-left.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/drag-left.png",
      import.meta.url,
    ).href,
    loop: true,
  },
  "elastic-swoop": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/elastic-swoop.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/elastic-swoop.png",
      import.meta.url,
    ).href,
    loop: false,
  },
  "release-settle": {
    video: new URL(
      "../../assets/pebble/reference-v3.1/animations/release-settle.webm",
      import.meta.url,
    ).href,
    still: new URL(
      "../../assets/pebble/reference-v3.1/stills/release-settle.png",
      import.meta.url,
    ).href,
    loop: false,
  },
} as const;
