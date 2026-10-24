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
          {/* Pearlescent Ceramic Pebble Gradient */}
          <linearGradient id="pebCeramic" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="42%" stopColor="#F1F5F9" />
            <stop offset="78%" stopColor="#E2E8F0" />
            <stop offset="100%" stopColor="#CBD5E1" />
          </linearGradient>

          {/* Deep Obsidian OLED Visor */}
          <linearGradient id="pebOled" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0B0F19" />
            <stop offset="100%" stopColor="#020617" />
          </linearGradient>

          {/* Magnetic Hands Gradient */}
          <linearGradient id="pebHand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="70%" stopColor="#E2E8F0" />
            <stop offset="100%" stopColor="#94A3B8" />
          </linearGradient>

          {/* Electric Cyan Neon Bloom */}
          <filter id="pebNeon" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.5" result="blur1" />
            <feGaussianBlur stdDeviation="1.5" result="blur2" />
            <feMerge>
              <feMergeNode in="blur1" />
              <feMergeNode in="blur2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Hover Levitation Particle Aura */}
          <radialGradient id="pebAura" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(56, 189, 248, 0.65)" />
            <stop offset="60%" stopColor="rgba(56, 189, 248, 0.2)" />
            <stop offset="100%" stopColor="rgba(56, 189, 248, 0)" />
          </radialGradient>
        </defs>

        {/* 1. LEVITATION HOVER AURA (Pulses under the robot) */}
        <g className="pebble-aura-group">
          <ellipse cx="100" cy="204" rx="42" ry="12" fill="url(#pebAura)" />
          <ellipse
            cx="100"
            cy="204"
            rx="24"
            ry="6"
            fill="#38BDF8"
            opacity="0.5"
            filter="url(#pebNeon)"
          />
        </g>

        {/* 2. FLOATING MAGNETIC HANDS (Animate independently beside body) */}
        <g className="pebble-hands-layer">
          {/* Left Floating Hand */}
          <g className="pebble-hand-left">
            <ellipse
              cx="34"
              cy="120"
              rx="10"
              ry="16"
              fill="url(#pebHand)"
              stroke="#94A3B8"
              strokeWidth="1.8"
            />
            {/* Subtle joint glow dot */}
            <circle cx="34" cy="116" r="2.2" fill="#38BDF8" opacity="0.8" />
          </g>

          {/* Right Floating Hand */}
          <g className="pebble-hand-right">
            <ellipse
              cx="166"
              cy="120"
              rx="10"
              ry="16"
              fill="url(#pebHand)"
              stroke="#94A3B8"
              strokeWidth="1.8"
            />
            {/* Subtle joint glow dot */}
            <circle cx="166" cy="116" r="2.2" fill="#38BDF8" opacity="0.8" />
          </g>
        </g>

        {/* 3. MAIN PEBBLE CHASSIS & HEAD (Smooth organic pod) */}
        <g className="pebble-main-pod">
          {/* Antenna & 3D Cobblestone Block */}
          <g className="pebble-antenna-stem">
            <path
              d="M 100 48 C 100 32, 106 24, 110 16"
              stroke="#94A3B8"
              strokeWidth="3.2"
              strokeLinecap="round"
            />
            <circle
              cx="110"
              cy="16"
              r="4.5"
              fill="#38BDF8"
              filter="url(#pebNeon)"
            />

            {/* Floating Mini 3D Cobblestone Cube */}
            <g transform="translate(104, -4) scale(0.85)">
              <polygon
                points="12,0 24,6 12,12 0,6"
                fill="#94A3B8"
                stroke="#334155"
                strokeWidth="0.8"
              />
              <polygon
                points="0,6 12,12 12,24 0,18"
                fill="#475569"
                stroke="#334155"
                strokeWidth="0.8"
              />
              <polygon
                points="12,12 24,6 24,18 12,24"
                fill="#334155"
                stroke="#1E293B"
                strokeWidth="0.8"
              />
              <rect x="3" y="9" width="3" height="3" fill="#64748B" />
              <rect x="15" y="14" width="3" height="3" fill="#1E293B" />
            </g>
          </g>

          {/* Smooth Pebble Body Form */}
          <path
            d="M 100 45 C 142 45, 160 70, 160 114 C 160 156, 138 188, 100 188 C 62 188, 40 156, 40 114 C 40 70, 58 45, 100 45 Z"
            fill="url(#pebCeramic)"
            stroke="#94A3B8"
            strokeWidth="2.4"
          />

          {/* Under-body Shadow Contour for Depth */}
          <path
            d="M 64 165 C 78 180, 122 180, 136 165 C 128 178, 72 178, 64 165 Z"
            fill="#94A3B8"
            opacity="0.35"
          />

          {/* Embedded Curved OLED Visor */}
          <path
            d="M 100 64 C 130 64, 144 76, 144 104 C 144 128, 130 142, 100 142 C 70 142, 56 128, 56 104 C 56 76, 70 64, 100 64 Z"
            fill="url(#pebOled)"
            stroke="#1E293B"
            strokeWidth="2"
          />

          {/* Visor Glass Reflection Highlight Curve */}
          <path
            d="M 72 73 C 86 68, 114 68, 128 73 C 120 78, 80 78, 72 73 Z"
            fill="white"
            opacity="0.16"
          />

          {/* Lower Torso Core Status Light */}
          <circle
            className="pebble-power-core"
            cx="100"
            cy="166"
            r="4"
            fill="#0284C7"
            stroke="#38BDF8"
            strokeWidth="1.4"
            filter="url(#pebNeon)"
          />

          {/* 4. FACIAL EXPRESSIONS & LIVING EYES */}
          {mode === "normal" && (
            <g filter="url(#pebNeon)">
              {/* Alive Blinking & Glancing Eyes */}
              <g className="pebble-eyes-alive">
                {/* Left Eye */}
                <rect x="76" y="88" width="13" height="18" rx="6.5" fill="#38BDF8" />
                <circle cx="80.5" cy="92.5" r="2.4" fill="#FFFFFF" />
                {/* Right Eye */}
                <rect x="111" y="88" width="13" height="18" rx="6.5" fill="#38BDF8" />
                <circle cx="115.5" cy="92.5" r="2.4" fill="#FFFFFF" />
              </g>
              {/* Subtle Happy Mouth */}
              <path
                d="M 96 118 C 98 122, 102 122, 104 118"
                stroke="#38BDF8"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          )}

          {mode === "idle" && (
            <g filter="url(#pebNeon)" className="pebble-eyes-sleeping">
              {/* Happy Sleepy Curved Arcs */}
              <path
                d="M 73 98 C 77 88, 89 88, 93 98"
                stroke="#38BDF8"
                strokeWidth="3.6"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M 107 98 C 111 88, 123 88, 127 98"
                stroke="#38BDF8"
                strokeWidth="3.6"
                strokeLinecap="round"
                fill="none"
              />
              {/* Content Sleeping Smile */}
              <path
                d="M 96 118 C 98 121, 102 121, 104 118"
                stroke="#38BDF8"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          )}

          {mode === "dragging" && (
            <g filter="url(#pebNeon)">
              {/* Wide Surprised Eyes */}
              <circle cx="82" cy="97" r="10" fill="#38BDF8" />
              <circle cx="84.5" cy="94" r="3.2" fill="#FFFFFF" />
              <circle cx="118" cy="97" r="10" fill="#38BDF8" />
              <circle cx="120.5" cy="94" r="3.2" fill="#FFFFFF" />
              {/* Cute Surprised 'o' Mouth */}
              <ellipse
                cx="100"
                cy="119"
                rx="4"
                ry="5.5"
                fill="#38BDF8"
                opacity="0.9"
              />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}
