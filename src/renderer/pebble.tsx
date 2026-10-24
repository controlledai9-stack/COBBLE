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
          {/* Metallic Periwinkle / Purple Armor Gradient */}
          <linearGradient id="pebArmor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9B91F0" />
            <stop offset="28%" stopColor="#7C71D8" />
            <stop offset="70%" stopColor="#5B50A0" />
            <stop offset="100%" stopColor="#3E3675" />
          </linearGradient>

          {/* Deep Visor Obsidian Black Gradient */}
          <linearGradient id="pebVisor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0F1424" />
            <stop offset="45%" stopColor="#080B14" />
            <stop offset="100%" stopColor="#020408" />
          </linearGradient>

          {/* Dark Titanium Joint Rings */}
          <linearGradient id="pebJoint" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4A516E" />
            <stop offset="50%" stopColor="#2D3349" />
            <stop offset="100%" stopColor="#1B1F2E" />
          </linearGradient>

          {/* Radiant Amber Glow Filter */}
          <filter id="pebAmberGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="blur1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.2" result="blur2" />
            <feMerge>
              <feMergeNode in="blur1" />
              <feMergeNode in="blur2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Amber Core Radial Light */}
          <radialGradient id="pebAmberRadial" cx="40%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#FFFBEB" />
            <stop offset="35%" stopColor="#FDE047" />
            <stop offset="70%" stopColor="#F59E0B" />
            <stop offset="100%" stopColor="#D97706" />
          </radialGradient>

          {/* Ground Thruster / Hover Plasma Glow */}
          <radialGradient id="pebThruster" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(245, 158, 11, 0.75)" />
            <stop offset="50%" stopColor="rgba(245, 158, 11, 0.25)" />
            <stop offset="100%" stopColor="rgba(245, 158, 11, 0)" />
          </radialGradient>
        </defs>

        {/* 1. HOVER PLASMA GLOW / GROUND SHADOW */}
        <g className="pebble-aura-group">
          <ellipse cx="100" cy="212" rx="44" ry="10" fill="url(#pebThruster)" />
          <ellipse cx="100" cy="212" rx="24" ry="5" fill="#F59E0B" opacity="0.6" filter="url(#pebAmberGlow)" />
        </g>

        {/* 2. LEGS & CORRUGATED JOINTS */}
        <g className="pebble-legs-layer">
          {/* Left Leg */}
          <g className="pebble-leg-left">
            {/* Corrugated Hip & Knee Rings */}
            <rect x="74" y="174" width="12" height="5" rx="2" fill="url(#pebJoint)" stroke="#171A27" strokeWidth="0.8" />
            <rect x="73" y="179" width="14" height="6" rx="2" fill="url(#pebJoint)" stroke="#171A27" strokeWidth="0.8" />
            {/* Periwinkle Thigh / Shin Armor */}
            <rect x="72" y="185" width="16" height="14" rx="4" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.2" />
            {/* Boot */}
            <ellipse cx="80" cy="202" rx="12" ry="7" fill="#1E2338" stroke="#101320" strokeWidth="1.4" />
            <ellipse cx="80" cy="202" rx="6" ry="3" fill="#F59E0B" opacity="0.75" filter="url(#pebAmberGlow)" />
          </g>

          {/* Right Leg */}
          <g className="pebble-leg-right">
            {/* Corrugated Hip & Knee Rings */}
            <rect x="114" y="174" width="12" height="5" rx="2" fill="url(#pebJoint)" stroke="#171A27" strokeWidth="0.8" />
            <rect x="113" y="179" width="14" height="6" rx="2" fill="url(#pebJoint)" stroke="#171A27" strokeWidth="0.8" />
            {/* Periwinkle Thigh / Shin Armor */}
            <rect x="112" y="185" width="16" height="14" rx="4" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.2" />
            {/* Boot */}
            <ellipse cx="120" cy="202" rx="12" ry="7" fill="#1E2338" stroke="#101320" strokeWidth="1.4" />
            <ellipse cx="120" cy="202" rx="6" ry="3" fill="#F59E0B" opacity="0.75" filter="url(#pebAmberGlow)" />
          </g>
        </g>

        {/* 3. MAIN ROBOT POD (HEAD & TORSO) - Anchored at Face Center (100, 97) */}
        <g className="pebble-main-pod">
          {/* Corrugated Metallic Neck Collar */}
          <rect x="88" y="132" width="24" height="8" rx="3" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="1" />
          <line x1="94" y1="132" x2="94" y2="140" stroke="#1A1E2E" strokeWidth="1" />
          <line x1="100" y1="132" x2="100" y2="140" stroke="#1A1E2E" strokeWidth="1" />
          <line x1="106" y1="132" x2="106" y2="140" stroke="#1A1E2E" strokeWidth="1" />

          {/* Torso Armor */}
          <path
            d="M 80 138 C 80 138, 70 148, 72 172 C 72 176, 128 176, 128 172 C 130 148, 120 138, 120 138 Z"
            fill="url(#pebArmor)"
            stroke="#2D284E"
            strokeWidth="1.8"
          />

          {/* Torso Center Seam & Contour */}
          <line x1="100" y1="138" x2="100" y2="174" stroke="#4A4186" strokeWidth="1.2" strokeDasharray="3 2" />

          {/* Glowing Radiant Amber Chest Reactor Core */}
          <circle cx="100" cy="156" r="10.5" fill="#171B2D" stroke="#2D284E" strokeWidth="1.6" />
          <circle cx="100" cy="156" r="7.5" fill="url(#pebAmberRadial)" filter="url(#pebAmberGlow)" />
          <circle cx="98" cy="154" r="2.2" fill="#FFFFFF" opacity="0.9" />

          {/* Golden Antenna with Luminous Glowing Bulb */}
          <g className="pebble-antenna-stem">
            <rect x="96.5" y="38" width="7" height="6" rx="2" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="0.8" />
            <path d="M 100 38 L 100 24" stroke="#4A516E" strokeWidth="3.2" strokeLinecap="round" />
            <circle cx="100" cy="16" r="9.5" fill="url(#pebAmberRadial)" filter="url(#pebAmberGlow)" />
            <circle cx="97.5" cy="13.5" r="3" fill="#FFFFFF" opacity="0.85" />
          </g>

          {/* Side Audio Muff Ear-Pods (Periwinkle with Amber Glowing Center) */}
          <g className="pebble-ear-nodes">
            {/* Left Ear Muff */}
            <ellipse cx="43" cy="94" rx="8" ry="18" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.6" />
            <ellipse cx="43" cy="94" rx="4.5" ry="11" fill="#171A29" />
            <circle cx="43" cy="94" r="3" fill="#F59E0B" filter="url(#pebAmberGlow)" opacity="0.9" />

            {/* Right Ear Muff */}
            <ellipse cx="157" cy="94" rx="8" ry="18" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.6" />
            <ellipse cx="157" cy="94" rx="4.5" ry="11" fill="#171A29" />
            <circle cx="157" cy="94" r="3" fill="#F59E0B" filter="url(#pebAmberGlow)" opacity="0.9" />
          </g>

          {/* Rounded Periwinkle Helmet Shell */}
          <path
            d="M 100 44 C 148 44, 164 68, 164 96 C 164 126, 146 138, 100 138 C 54 138, 36 126, 36 96 C 36 68, 52 44, 100 44 Z"
            fill="url(#pebArmor)"
            stroke="#2D284E"
            strokeWidth="2.4"
          />

          {/* Glossy Helmet Specular Light Highlight */}
          <path
            d="M 68 56 C 80 50, 120 50, 132 56 C 118 52, 82 52, 68 56 Z"
            fill="#FFFFFF"
            opacity="0.5"
          />

          {/* Deep Obsidian Curved OLED Visor Screen */}
          <path
            d="M 100 59 C 137 59, 149 73, 149 97 C 149 121, 137 131, 100 131 C 63 131, 51 121, 51 97 C 51 73, 63 59, 100 59 Z"
            fill="url(#pebVisor)"
            stroke="#171A29"
            strokeWidth="2"
          />

          {/* Visor Curved Glass Specular Highlight */}
          <path
            d="M 66 69 C 80 64, 120 64, 134 69 C 122 74, 78 74, 66 69 Z"
            fill="#FFFFFF"
            opacity="0.18"
          />

          {/* 4. FACIAL EXPRESSIONS IN RADIANT AMBER (Centered at 100, 97) */}
          {mode === "normal" && (
            <g filter="url(#pebAmberGlow)">
              {/* Alive Cheerful Glowing Amber Curved Eyes (^ ^) */}
              <g className="pebble-eyes-alive">
                {/* Left Eye */}
                <path
                  d="M 76 98 C 81 87, 91 87, 96 98"
                  stroke="#F59E0B"
                  strokeWidth="3.8"
                  strokeLinecap="round"
                  fill="none"
                />
                <circle cx="86" cy="89" r="1.5" fill="#FFFBEB" />

                {/* Right Eye */}
                <path
                  d="M 104 98 C 109 87, 119 87, 124 98"
                  stroke="#F59E0B"
                  strokeWidth="3.8"
                  strokeLinecap="round"
                  fill="none"
                />
                <circle cx="114" cy="89" r="1.5" fill="#FFFBEB" />
              </g>

              {/* Cheerful Golden Smile */}
              <path
                d="M 94 112 C 97 117, 103 117, 106 112"
                stroke="#F59E0B"
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          )}

          {mode === "idle" && (
            <g className="pebble-eyes-sleeping" filter="url(#pebAmberGlow)">
              {/* Sweet Peaceful Sleeping Eyes */}
              <path
                d="M 75 98 C 79 92, 89 92, 93 98"
                stroke="#F59E0B"
                strokeWidth="3.4"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M 107 98 C 111 92, 121 92, 125 98"
                stroke="#F59E0B"
                strokeWidth="3.4"
                strokeLinecap="round"
                fill="none"
              />
              {/* Content Sleepy Smile */}
              <path
                d="M 96 113 C 98 116, 102 116, 104 113"
                stroke="#F59E0B"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />

              {/* Floating Amber ZZZ Bubbles */}
              <g className="pebble-zzz" opacity="0.85">
                <text x="124" y="52" fill="#F59E0B" fontSize="13" fontWeight="bold" fontFamily="sans-serif">z</text>
                <text x="136" y="38" fill="#FDE047" fontSize="16" fontWeight="bold" fontFamily="sans-serif">Z</text>
              </g>
            </g>
          )}

          {mode === "dragging" && (
            <g filter="url(#pebAmberGlow)">
              {/* Dizzy Spiral / Startled Amber Eyes (@ @) */}
              <g className="pebble-spiral-eyes">
                {/* Left Spiral */}
                <path
                  d="M 86 96 A 4 4 0 0 1 82 100 A 7 7 0 0 1 76 94 A 10 10 0 0 1 86 86 A 12 12 0 0 1 96 97"
                  stroke="#F59E0B"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  fill="none"
                />
                {/* Right Spiral */}
                <path
                  d="M 114 96 A 4 4 0 0 1 110 100 A 7 7 0 0 1 104 94 A 10 10 0 0 1 114 86 A 12 12 0 0 1 124 97"
                  stroke="#F59E0B"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  fill="none"
                />
              </g>

              {/* Startled Wavy Mouth */}
              <path
                d="M 92 113 C 95 110, 97 116, 100 113 C 103 110, 105 116, 108 113"
                stroke="#F59E0B"
                strokeWidth="2.2"
                strokeLinecap="round"
                fill="none"
              />
            </g>
          )}

          {/* 5. ARMS AND HANDS WITH CORRUGATED FLEXIBLE JOINTS */}
          <g className="pebble-hands-layer">
            {/* Left Arm & Cheerful Waving Hand */}
            <g className="pebble-hand-left">
              {/* Shoulder Corrugated Joint */}
              <circle cx="68" cy="144" r="5" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="0.8" />
              {/* Corrugated Elbow Rings */}
              <rect x="52" y="146" width="8" height="5" rx="1.5" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="0.8" />
              {/* Periwinkle Forearm */}
              <rect x="42" y="142" width="12" height="18" rx="4" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.2" transform="rotate(20 48 151)" />
              {/* Metallic Waving Mitten Hand */}
              <ellipse cx="44" cy="154" rx="7" ry="9" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.4" />
            </g>

            {/* Right Arm & Friendly Hand */}
            <g className="pebble-hand-right">
              {/* Shoulder Corrugated Joint */}
              <circle cx="132" cy="144" r="5" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="0.8" />
              {/* Corrugated Elbow Rings */}
              <rect x="140" y="146" width="8" height="5" rx="1.5" fill="url(#pebJoint)" stroke="#1A1E2E" strokeWidth="0.8" />
              {/* Periwinkle Forearm */}
              <rect x="146" y="142" width="12" height="18" rx="4" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.2" transform="rotate(-20 152 151)" />
              {/* Metallic Hand */}
              <ellipse cx="156" cy="154" rx="7" ry="9" fill="url(#pebArmor)" stroke="#2D284E" strokeWidth="1.4" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
