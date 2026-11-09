import React from "react";
import type { CompanionMode } from "../shared/types";

export function PebbleRobot({
  mode,
  className = "",
}: {
  mode: CompanionMode;
  className?: string;
}) {
  return (
    <div className={`pebble-companion-root mode-${mode} ${className}`}>
      <svg
        className="pebble-svg-frame"
        width="110"
        height="125"
        viewBox="0 0 200 230"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* 1. Translucent Celestial Jelly / Glass Body Gradients */}
          <linearGradient id="pebGlassBody" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.92" />
            <stop offset="16%" stopColor="#E0EEFF" stopOpacity="0.78" />
            <stop offset="48%" stopColor="#C7DDFF" stopOpacity="0.55" />
            <stop offset="80%" stopColor="#B4D0FE" stopOpacity="0.78" />
            <stop offset="100%" stopColor="#93A5F8" stopOpacity="0.92" />
          </linearGradient>

          {/* Prismatic Iridescent Rim Contour */}
          <linearGradient id="pebIridescentRim" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#DDD6FE" />
            <stop offset="28%" stopColor="#93C5FD" />
            <stop offset="60%" stopColor="#67E8F9" />
            <stop offset="82%" stopColor="#C084FC" />
            <stop offset="100%" stopColor="#F472B6" />
          </linearGradient>

          {/* 2. Planetary Orbital Ring Gradients */}
          <linearGradient id="pebRingBack" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.5" />
            <stop offset="50%" stopColor="#93C5FD" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#DDD6FE" stopOpacity="0.45" />
          </linearGradient>

          <linearGradient id="pebRingFront" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#EDE9FE" stopOpacity="0.95" />
            <stop offset="25%" stopColor="#C4B5FD" stopOpacity="0.88" />
            <stop offset="55%" stopColor="#A5F3FC" stopOpacity="0.92" />
            <stop offset="80%" stopColor="#DDD6FE" stopOpacity="0.88" />
            <stop offset="100%" stopColor="#BAE6FD" stopOpacity="0.95" />
          </linearGradient>

          <linearGradient id="pebRingGlow" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(196, 181, 253, 0.7)" />
            <stop offset="50%" stopColor="rgba(165, 243, 252, 0.85)" />
            <stop offset="100%" stopColor="rgba(224, 231, 255, 0.6)" />
          </linearGradient>

          {/* 3. Cosmic Core Nebula & Galaxy Swirl Gradients */}
          <radialGradient id="pebNebulaCore" cx="48%" cy="46%" r="52%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.95" />
            <stop offset="25%" stopColor="#DDD6FE" stopOpacity="0.8" />
            <stop offset="50%" stopColor="#C4B5FD" stopOpacity="0.6" />
            <stop offset="75%" stopColor="#818CF8" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#6366F1" stopOpacity="0" />
          </radialGradient>

          <radialGradient id="pebGalaxySwirl" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FFFBEB" stopOpacity="0.92" />
            <stop offset="35%" stopColor="#FBCFE8" stopOpacity="0.75" />
            <stop offset="65%" stopColor="#C4B5FD" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#818CF8" stopOpacity="0" />
          </radialGradient>

          {/* 4. Caustic Specular Highlights */}
          <linearGradient id="pebCrestHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.88" />
            <stop offset="60%" stopColor="#FFFFFF" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>

          {/* 5. Ground Caustic Glow */}
          <radialGradient id="pebGroundCaustic" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(147, 197, 253, 0.7)" />
            <stop offset="45%" stopColor="rgba(196, 181, 253, 0.35)" />
            <stop offset="75%" stopColor="rgba(165, 243, 252, 0.15)" />
            <stop offset="100%" stopColor="rgba(224, 231, 255, 0)" />
          </radialGradient>

          {/* 6. Glowing Cyan Eye Filter */}
          <filter id="pebCyanGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.0" result="blur2" />
            <feMerge>
              <feMergeNode in="blur1" />
              <feMergeNode in="blur2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="pebSoftBlur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3.2" />
          </filter>
        </defs>

        {/* 1. GROUND CAUSTIC GLOW / LEVITATION SHADOW */}
        <g className="pebble-ground-aura">
          <ellipse cx="100" cy="208" rx="46" ry="11" fill="url(#pebGroundCaustic)" />
          <ellipse cx="100" cy="208" rx="26" ry="5.5" fill="#93C5FD" opacity="0.45" filter="url(#pebCyanGlow)" />
        </g>

        {/* 2. MAIN CELESTIAL DROPLET POD - Anchored at Face Center (100, 97) */}
        <g className="pebble-main-pod">
          {/* A. PLANETARY ORBITAL RING - BACK HALF (Passes Behind Droplet) */}
          <g className="pebble-orbital-ring-back" transform="rotate(-15 100 120)">
            <path
              d="M 24 120 A 76 18 0 0 1 176 120"
              stroke="url(#pebRingGlow)"
              strokeWidth="9"
              opacity="0.5"
              strokeLinecap="round"
            />
            <path
              d="M 24 120 A 76 18 0 0 1 176 120"
              stroke="url(#pebRingBack)"
              strokeWidth="6"
              strokeLinecap="round"
            />
          </g>

          {/* B. GELATINOUS DROPLET BODY */}
          {mode === "dragging" ? (
            /* Elastic elongated fluid deformation while dragging */
            <g className="pebble-body-stretching">
              <path
                d="M 100 36 C 124 36, 154 62, 152 104 C 150 148, 142 184, 126 194 C 112 202, 106 188, 100 188 C 94 188, 88 202, 74 194 C 58 184, 50 148, 48 104 C 46 62, 76 36, 100 36 Z"
                fill="url(#pebGlassBody)"
                stroke="url(#pebIridescentRim)"
                strokeWidth="2.2"
              />
              {/* Trailing dynamic fluid droplets */}
              <circle cx="42" cy="192" r="3" fill="url(#pebGlassBody)" stroke="#93C5FD" strokeWidth="0.8" />
              <circle cx="158" cy="190" r="3.5" fill="url(#pebGlassBody)" stroke="#93C5FD" strokeWidth="0.8" />
              <circle cx="100" cy="204" r="2.5" fill="url(#pebGlassBody)" stroke="#93C5FD" strokeWidth="0.8" />
            </g>
          ) : (
            /* Plump translucent gelatinous droplet sitting / floating peacefully */
            <g className="pebble-body-resting">
              <path
                d="M 100 48 C 128 48, 160 70, 162 108 C 164 138, 154 166, 134 172 C 118 177, 108 168, 100 168 C 92 168, 82 177, 66 172 C 46 166, 36 138, 38 108 C 40 70, 72 48, 100 48 Z"
                fill="url(#pebGlassBody)"
                stroke="url(#pebIridescentRim)"
                strokeWidth="2.4"
              />
            </g>
          )}

          {/* C. INTERNAL COSMIC CORE & GALAXY NEBULA */}
          <circle
            cx="100"
            cy="114"
            r="35"
            fill="url(#pebNebulaCore)"
            className="pebble-cosmic-core"
          />

          {/* Micro Cosmic Starlight Dust */}
          <circle cx="88" cy="108" r="1.3" fill="#FFFFFF" opacity="0.9" />
          <circle cx="114" cy="118" r="1.4" fill="#FFFFFF" opacity="0.85" />
          <circle cx="102" cy="130" r="1.1" fill="#FFFFFF" opacity="0.8" />
          <circle cx="94" cy="124" r="0.9" fill="#FFFFFF" opacity="0.9" />

          {/* Idle Sleep Mode: Rotating Spiral Milky Way Swirl */}
          {mode === "idle" && (
            <g className="pebble-galaxy-swirl">
              <ellipse
                cx="100"
                cy="116"
                rx="24"
                ry="10"
                fill="url(#pebGalaxySwirl)"
                transform="rotate(-20 100 116)"
                opacity="0.9"
              />
              <path
                d="M 85 119 C 90 124, 105 125, 114 118 C 120 113, 116 108, 108 107 C 98 106, 92 113, 97 118"
                stroke="#FFFFFF"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
                opacity="0.85"
              />
            </g>
          )}

          {/* D. GLASS CAUSTICS & SPECULAR LIGHT SHEEN */}
          {/* Top crest curvature glint */}
          <path
            d="M 74 58 C 86 52, 114 52, 126 58 C 114 55, 86 55, 74 58 Z"
            fill="url(#pebCrestHighlight)"
          />
          {/* Left mantle sheen */}
          <path
            d="M 48 80 C 44 95, 48 116, 56 128 C 50 116, 48 95, 52 82 Z"
            fill="#FFFFFF"
            opacity="0.45"
          />
          {/* Right mantle sheen */}
          <path
            d="M 152 80 C 156 95, 152 116, 144 128 C 150 116, 152 95, 148 82 Z"
            fill="#FFFFFF"
            opacity="0.45"
          />
          {/* Bottom resting fluid folds */}
          <path
            d="M 64 162 C 72 170, 92 170, 98 165"
            stroke="rgba(255,255,255,0.6)"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M 102 165 C 108 170, 128 170, 136 162"
            stroke="rgba(255,255,255,0.6)"
            strokeWidth="1.8"
            strokeLinecap="round"
            fill="none"
          />

          {/* E. FACIAL EXPRESSIONS (Centered around 100, 97) */}
          {mode === "normal" && (
            <g className="pebble-face-normal">
              {/* Soft Rosy Cheeks */}
              <circle cx="68" cy="112" r="7" fill="#F472B6" opacity="0.25" filter="url(#pebSoftBlur)" />
              <circle cx="132" cy="112" r="7" fill="#F472B6" opacity="0.25" filter="url(#pebSoftBlur)" />

              {/* Expressive Vertical Capsule Eyes with Cyan Slit Glow */}
              <g className="pebble-eyes-alive">
                {/* Left Eye */}
                <rect x="78" y="86" width="12" height="22" rx="6" fill="#181B34" />
                <rect
                  x="82.5"
                  y="89"
                  width="3"
                  height="12"
                  rx="1.5"
                  fill="#67E8F9"
                  filter="url(#pebCyanGlow)"
                />
                <rect x="83" y="90" width="2" height="10" rx="1" fill="#FFFFFF" />
                <circle cx="84" cy="88" r="1.3" fill="#FFFFFF" />

                {/* Right Eye */}
                <rect x="110" y="86" width="12" height="22" rx="6" fill="#181B34" />
                <rect
                  x="114.5"
                  y="89"
                  width="3"
                  height="12"
                  rx="1.5"
                  fill="#67E8F9"
                  filter="url(#pebCyanGlow)"
                />
                <rect x="115" y="90" width="2" height="10" rx="1" fill="#FFFFFF" />
                <circle cx="116" cy="88" r="1.3" fill="#FFFFFF" />

                {/* Sweet Gentle Smile */}
                <path
                  d="M 96 114 C 98 117, 102 117, 104 114"
                  stroke="#312E81"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  fill="none"
                />
              </g>
            </g>
          )}

          {mode === "idle" && (
            <g className="pebble-eyes-sleeping">
              {/* Soft Rosy Sleep Cheeks */}
              <circle cx="68" cy="112" r="7" fill="#F472B6" opacity="0.3" filter="url(#pebSoftBlur)" />
              <circle cx="132" cy="112" r="7" fill="#F472B6" opacity="0.3" filter="url(#pebSoftBlur)" />

              {/* Peaceful Closed Eyes with Gentle Eyelashes */}
              {/* Left Eye */}
              <path
                d="M 76 96 C 80 102, 90 102, 94 96"
                stroke="#1E1B4B"
                strokeWidth="3.2"
                strokeLinecap="round"
                fill="none"
              />
              <line x1="93" y1="96" x2="97" y2="92" stroke="#1E1B4B" strokeWidth="2" strokeLinecap="round" />
              <line x1="95" y1="98" x2="99" y2="96" stroke="#1E1B4B" strokeWidth="1.8" strokeLinecap="round" />

              {/* Right Eye */}
              <path
                d="M 106 96 C 110 102, 120 102, 124 96"
                stroke="#1E1B4B"
                strokeWidth="3.2"
                strokeLinecap="round"
                fill="none"
              />
              <line x1="123" y1="96" x2="127" y2="92" stroke="#1E1B4B" strokeWidth="2" strokeLinecap="round" />
              <line x1="125" y1="98" x2="129" y2="96" stroke="#1E1B4B" strokeWidth="1.8" strokeLinecap="round" />

              {/* Serene Contented Smile */}
              <path
                d="M 96 113 C 98 116.5, 102 116.5, 104 113"
                stroke="#312E81"
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
              />

              {/* Floating Celestial Starlight ZZZ */}
              <g className="pebble-zzz" opacity="0.85">
                <text x="132" y="52" fill="#A78BFA" fontSize="12" fontWeight="bold" fontFamily="system-ui, sans-serif">z</text>
                <text x="144" y="38" fill="#818CF8" fontSize="15" fontWeight="bold" fontFamily="system-ui, sans-serif">Z</text>
                <path d="M 154 22 Q 154 26 158 26 Q 154 26 154 30 Q 154 26 150 26 Q 154 26 154 22 Z" fill="#FDE047" opacity="0.9" />
              </g>
            </g>
          )}

          {mode === "dragging" && (
            <g className="pebble-eyes-dragging">
              {/* Wide Startled Capsule Eyes */}
              <rect x="77" y="82" width="14" height="24" rx="7" fill="#181B34" />
              <circle cx="84" cy="92" r="3.5" fill="#67E8F9" filter="url(#pebCyanGlow)" />
              <circle cx="84" cy="91" r="2" fill="#FFFFFF" />

              <rect x="109" y="82" width="14" height="24" rx="7" fill="#181B34" />
              <circle cx="116" cy="92" r="3.5" fill="#67E8F9" filter="url(#pebCyanGlow)" />
              <circle cx="116" cy="91" r="2" fill="#FFFFFF" />

              {/* Surprised "O" Mouth */}
              <ellipse cx="100" cy="116" rx="4" ry="5.5" fill="#1E1B4B" />
            </g>
          )}

          {/* F. PLANETARY ORBITAL RING - FRONT HALF (Passes in Front of Droplet) */}
          <g className="pebble-orbital-ring-front" transform="rotate(-15 100 120)">
            <path
              d="M 176 120 A 76 18 0 0 1 24 120"
              stroke="url(#pebRingGlow)"
              strokeWidth="10"
              opacity="0.5"
              strokeLinecap="round"
            />
            <path
              d="M 176 120 A 76 18 0 0 1 24 120"
              stroke="url(#pebRingFront)"
              strokeWidth="6.5"
              strokeLinecap="round"
            />
            {/* Luminous Specular Caustic Arc on Ring */}
            <path
              d="M 168 122 A 68 15 0 0 1 32 122"
              stroke="#FFFFFF"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0.85"
            />
          </g>

          {/* G. CELESTIAL STAR SPARKLE & FLOATING MICRO DROPLETS */}
          <path
            d="M 170 56 Q 170 62 176 62 Q 170 62 170 68 Q 170 62 164 62 Q 170 62 170 56 Z"
            fill="#C4B5FD"
            opacity="0.85"
            className="pebble-star-sparkle"
          />
          <circle cx="32" cy="78" r="3" fill="#BAE6FD" opacity="0.75" />
          <circle cx="31" cy="77" r="1" fill="#FFFFFF" opacity="0.9" />
          <circle cx="166" cy="156" r="2.5" fill="#BAE6FD" opacity="0.75" />
        </g>
      </svg>
    </div>
  );
}
