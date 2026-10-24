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
    <svg
      className={`pebble-avatar pebble-mode-${mode} ${className}`}
      width="220"
      height="260"
      viewBox="0 0 220 260"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Soft pebble stone gradient */}
        <linearGradient id="pebBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="55%" stopColor="#E2E8F0" />
          <stop offset="100%" stopColor="#CBD5E1" />
        </linearGradient>

        {/* Deep obsidian glass visor */}
        <linearGradient id="pebScreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0F172A" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>

        {/* Electric cyan glow filter for eyes & chest core */}
        <filter id="pebGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ANTENNA STEM & MINECRAFT COBBLESTONE CUBE */}
      <g className="pebble-antenna">
        <path
          d="M125 46 C 135 34, 142 22, 145 12"
          stroke="#94A3B8"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        {/* Isometric 3D Cobblestone Cube */}
        <g transform="translate(138, 2)">
          <polygon
            points="12,0 24,6 12,12 0,6"
            fill="#94A3B8"
            stroke="#334155"
            strokeWidth="1"
          />
          <polygon
            points="0,6 12,12 12,25 0,19"
            fill="#475569"
            stroke="#334155"
            strokeWidth="1"
          />
          <polygon
            points="12,12 24,6 24,19 12,25"
            fill="#334155"
            stroke="#1E293B"
            strokeWidth="1"
          />
          <rect x="3" y="9" width="3" height="3" fill="#64748B" />
          <rect x="15" y="14" width="3" height="3" fill="#1E293B" />
          <rect x="18" y="9" width="2" height="2" fill="#64748B" />
        </g>
      </g>

      {/* HEAD */}
      <g
        className={
          mode === "idle"
            ? "pebble-head-idle"
            : mode === "dragging"
              ? "pebble-head-drag"
              : "pebble-head"
        }
      >
        {/* Rounded pebble chassis */}
        <rect
          x="52"
          y="42"
          width="108"
          height="88"
          rx="44"
          fill="url(#pebBody)"
          stroke="#94A3B8"
          strokeWidth="2.5"
        />
        {/* Side audio sensors */}
        <ellipse
          cx="50"
          cy="86"
          rx="6"
          ry="16"
          fill="#CBD5E1"
          stroke="#64748B"
          strokeWidth="2"
        />
        <ellipse cx="49" cy="86" rx="2" ry="8" fill="#38BDF8" />
        <ellipse
          cx="162"
          cy="86"
          rx="6"
          ry="16"
          fill="#CBD5E1"
          stroke="#64748B"
          strokeWidth="2"
        />
        <ellipse cx="163" cy="86" rx="2" ry="8" fill="#38BDF8" />

        {/* Dark curved faceplate */}
        <rect
          x="62"
          y="52"
          width="88"
          height="68"
          rx="30"
          fill="url(#pebScreen)"
          stroke="#1E293B"
          strokeWidth="2"
        />
        {/* Glass reflection highlight */}
        <path
          d="M72 60 C 84 56, 128 56, 140 60 C 130 66, 82 66, 72 60 Z"
          fill="white"
          opacity="0.12"
        />

        {/* EXPRESSIONS */}
        {mode === "normal" && (
          <g filter="url(#pebGlow)">
            {/* Blinking eyes */}
            <g className="pebble-eyes-blink">
              <ellipse cx="88" cy="86" rx="7" ry="9" fill="#38BDF8" />
              <circle cx="90" cy="84" r="2.5" fill="#FFFFFF" />
              <ellipse cx="124" cy="86" rx="7" ry="9" fill="#38BDF8" />
              <circle cx="126" cy="84" r="2.5" fill="#FFFFFF" />
            </g>
            {/* Cute smile */}
            <path
              d="M 100 99 C 103 103, 109 103, 112 99"
              stroke="#38BDF8"
              strokeWidth="2.5"
              strokeLinecap="round"
              fill="none"
            />
          </g>
        )}

        {mode === "idle" && (
          <g filter="url(#pebGlow)" className="pebble-eyes-idle">
            {/* Sleepy happy upward arcs */}
            <path
              d="M 80 88 C 84 79, 94 79, 98 88"
              stroke="#38BDF8"
              strokeWidth="4"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M 114 88 C 118 79, 128 79, 132 88"
              stroke="#38BDF8"
              strokeWidth="4"
              strokeLinecap="round"
              fill="none"
            />
            {/* Soft content mouth */}
            <path
              d="M 101 100 C 103 103, 109 103, 111 100"
              stroke="#38BDF8"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </g>
        )}

        {mode === "dragging" && (
          <g filter="url(#pebGlow)">
            {/* Surprised wide eyes */}
            <circle cx="87" cy="84" r="9.5" fill="#38BDF8" />
            <circle cx="89" cy="82" r="3.5" fill="#FFFFFF" />
            <circle cx="125" cy="84" r="9.5" fill="#38BDF8" />
            <circle cx="127" cy="82" r="3.5" fill="#FFFFFF" />
            {/* Cute "o" surprised mouth */}
            <ellipse cx="106" cy="99" rx="4.5" ry="5.5" fill="#38BDF8" opacity="0.9" />
          </g>
        )}
      </g>

      {/* TORSO */}
      <g transform="translate(0, 10)">
        <rect x="98" y="120" width="16" height="8" rx="3" fill="#64748B" />
        <path
          d="M76 128 C 76 128, 80 176, 86 184 C 92 190, 120 190, 126 184 C 132 176, 136 128, 136 128 Z"
          fill="url(#pebBody)"
          stroke="#94A3B8"
          strokeWidth="2.5"
        />
        {/* Cyan power core */}
        <circle
          className="pebble-core-light"
          cx="106"
          cy="152"
          r="5.5"
          fill="#0284C7"
          stroke="#38BDF8"
          strokeWidth="1.5"
          filter="url(#pebGlow)"
        />
      </g>

      {/* ARMS */}
      {mode === "normal" && (
        <g transform="translate(0, 10)">
          {/* Left arm */}
          <circle cx="68" cy="138" r="5" fill="#64748B" />
          <rect
            x="42"
            y="140"
            width="26"
            height="12"
            rx="6"
            transform="rotate(32 42 140)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="40" cy="164" r="4.5" fill="#475569" />

          {/* Right arm waving slightly */}
          <circle cx="144" cy="138" r="5" fill="#64748B" />
          <rect
            x="144"
            y="130"
            width="28"
            height="12"
            rx="6"
            transform="rotate(-38 144 130)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="174" cy="108" r="4.5" fill="#475569" />
        </g>
      )}

      {mode === "idle" && (
        <g transform="translate(0, 10)">
          {/* Arms folded calmly in lap */}
          <circle cx="68" cy="138" r="5" fill="#64748B" />
          <rect
            x="52"
            y="140"
            width="26"
            height="12"
            rx="6"
            transform="rotate(50 52 140)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="70" cy="166" r="4.5" fill="#475569" />

          <circle cx="144" cy="138" r="5" fill="#64748B" />
          <rect
            x="134"
            y="140"
            width="26"
            height="12"
            rx="6"
            transform="rotate(-50 134 140)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="142" cy="166" r="4.5" fill="#475569" />
        </g>
      )}

      {mode === "dragging" && (
        <g transform="translate(0, 10)">
          {/* Arms raised in air */}
          <circle cx="68" cy="134" r="5" fill="#64748B" />
          <rect
            x="36"
            y="126"
            width="28"
            height="11"
            rx="5.5"
            transform="rotate(-40 36 126)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="28" cy="104" r="4.5" fill="#475569" />

          <circle cx="144" cy="134" r="5" fill="#64748B" />
          <rect
            x="146"
            y="136"
            width="28"
            height="11"
            rx="5.5"
            transform="rotate(40 146 136)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <circle cx="184" cy="104" r="4.5" fill="#475569" />
        </g>
      )}

      {/* LEGS */}
      {mode === "normal" && (
        <g transform="translate(0, 10)">
          <circle cx="90" cy="188" r="5" fill="#64748B" />
          <rect
            x="78"
            y="192"
            width="14"
            height="26"
            rx="6"
            transform="rotate(10 78 192)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <ellipse
            cx="80"
            cy="224"
            rx="9"
            ry="5"
            fill="#334155"
            stroke="#1E293B"
            strokeWidth="1.5"
          />

          <circle cx="122" cy="188" r="5" fill="#64748B" />
          <rect
            x="118"
            y="192"
            width="14"
            height="26"
            rx="6"
            transform="rotate(-10 118 192)"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <ellipse
            cx="132"
            cy="224"
            rx="9"
            ry="5"
            fill="#334155"
            stroke="#1E293B"
            strokeWidth="1.5"
          />
        </g>
      )}

      {mode === "idle" && (
        <g transform="translate(0, 10)">
          {/* Neatly seated pebble beanbag posture */}
          <circle cx="86" cy="184" r="5" fill="#64748B" />
          <rect
            x="74"
            y="184"
            width="22"
            height="13"
            rx="6"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <ellipse
            cx="70"
            cy="196"
            rx="10"
            ry="6"
            fill="#334155"
            stroke="#1E293B"
            strokeWidth="1.5"
          />

          <circle cx="126" cy="184" r="5" fill="#64748B" />
          <rect
            x="116"
            y="184"
            width="22"
            height="13"
            rx="6"
            fill="url(#pebBody)"
            stroke="#94A3B8"
            strokeWidth="2"
          />
          <ellipse
            cx="142"
            cy="196"
            rx="10"
            ry="6"
            fill="#334155"
            stroke="#1E293B"
            strokeWidth="1.5"
          />
        </g>
      )}

      {mode === "dragging" && (
        <g transform="translate(0, 10)">
          {/* Dangling legs swaying with dragging physics */}
          <g className="pebble-leg-dangle-left">
            <circle cx="90" cy="188" r="5" fill="#64748B" />
            <rect
              x="82"
              y="192"
              width="13"
              height="28"
              rx="6"
              fill="url(#pebBody)"
              stroke="#94A3B8"
              strokeWidth="2"
            />
            <ellipse
              cx="86"
              cy="226"
              rx="9"
              ry="5"
              fill="#334155"
              stroke="#1E293B"
              strokeWidth="1.5"
            />
          </g>

          <g className="pebble-leg-dangle-right">
            <circle cx="122" cy="188" r="5" fill="#64748B" />
            <rect
              x="117"
              y="192"
              width="13"
              height="28"
              rx="6"
              fill="url(#pebBody)"
              stroke="#94A3B8"
              strokeWidth="2"
            />
            <ellipse
              cx="125"
              cy="226"
              rx="9"
              ry="5"
              fill="#334155"
              stroke="#1E293B"
              strokeWidth="1.5"
            />
          </g>
        </g>
      )}
    </svg>
  );
}
