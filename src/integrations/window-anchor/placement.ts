import { PlacementInput, PlacementResult, Rect } from './contracts.js';

function isValidRect(r: Rect | null | undefined): boolean {
  if (!r) return false;
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

function isValidSize(s: { width: number; height: number } | null | undefined): boolean {
  if (!s) return false;
  return (
    Number.isFinite(s.width) &&
    Number.isFinite(s.height) &&
    s.width > 0 &&
    s.height > 0
  );
}

function isValidOffset(o: { x: number; y: number } | null | undefined): boolean {
  if (!o) return false;
  return Number.isFinite(o.x) && Number.isFinite(o.y);
}

/**
 * Pure function to calculate companion placement relative to the IDE window.
 * Strictly operates in Electron Logical Coordinates (DIP).
 * 
 * Never imports Electron or performs OS side-effects.
 */
export function computeAnchorPlacement(input: PlacementInput): PlacementResult {
  // 1. Validate inputs
  if (
    !isValidRect(input.ideBoundsDip) ||
    !isValidRect(input.workAreaDip) ||
    !isValidSize(input.companionSizeDip) ||
    !isValidOffset(input.offsetDip)
  ) {
    return {
      visible: false,
      shouldMove: false,
      boundsDip: null,
      reason: 'Invalid or non-finite geometry',
    };
  }

  // 2. Dragging state: preserve companion position while user drags it
  if (input.dragging) {
    return {
      visible: true,
      shouldMove: false,
      boundsDip: null,
      reason: 'Companion is being dragged by user',
    };
  }

  // 3. Minimized / invisible editor
  if (input.editorMinimized || !input.editorVisible) {
    if (input.companionInteracting) {
      // User is interacting with Cobble's menu/mic controls; do NOT hide
      return {
        visible: true,
        shouldMove: false,
        boundsDip: null,
        reason: 'Editor is minimized or hidden, but companion interaction is active',
      };
    }
    return {
      visible: false,
      shouldMove: false,
      boundsDip: null,
      reason: 'Editor is minimized or hidden',
    };
  }

  const { ideBoundsDip, workAreaDip, companionSizeDip, offsetDip, preferredEdge } = input;

  // 4. Check if editor is completely off-screen relative to work area
  const overlapLeft = Math.max(ideBoundsDip.x, workAreaDip.x);
  const overlapTop = Math.max(ideBoundsDip.y, workAreaDip.y);
  const overlapRight = Math.min(ideBoundsDip.x + ideBoundsDip.width, workAreaDip.x + workAreaDip.width);
  const overlapBottom = Math.min(ideBoundsDip.y + ideBoundsDip.height, workAreaDip.y + workAreaDip.height);

  const isCompletelyOffScreen = overlapRight <= overlapLeft || overlapBottom <= overlapTop;
  if (isCompletelyOffScreen) {
    if (input.companionInteracting) {
      return {
        visible: true,
        shouldMove: false,
        boundsDip: null,
        reason: 'Editor is off-screen, but companion interaction is active',
      };
    }
    return {
      visible: false,
      shouldMove: false,
      boundsDip: null,
      reason: 'Editor is completely off-screen',
    };
  }

  // 5. Compute anchor position based on preferred edge
  let targetX = 0;
  let targetY = 0;

  switch (preferredEdge) {
    case 'left':
      targetX = ideBoundsDip.x - companionSizeDip.width + offsetDip.x;
      targetY = ideBoundsDip.y + offsetDip.y;
      break;
    case 'right':
      targetX = ideBoundsDip.x + ideBoundsDip.width + offsetDip.x;
      targetY = ideBoundsDip.y + offsetDip.y;
      break;
    case 'top':
      targetX = ideBoundsDip.x + offsetDip.x;
      targetY = ideBoundsDip.y - companionSizeDip.height + offsetDip.y;
      break;
    case 'bottom':
      targetX = ideBoundsDip.x + offsetDip.x;
      targetY = ideBoundsDip.y + ideBoundsDip.height + offsetDip.y;
      break;
    default:
      // Fallback to right edge
      targetX = ideBoundsDip.x + ideBoundsDip.width + offsetDip.x;
      targetY = ideBoundsDip.y + offsetDip.y;
      break;
  }

  // 6. Clamp within work area (handles negative monitor coordinates & tiny work areas)
  const minX = workAreaDip.x;
  const maxX = workAreaDip.x + Math.max(0, workAreaDip.width - companionSizeDip.width);
  const minY = workAreaDip.y;
  const maxY = workAreaDip.y + Math.max(0, workAreaDip.height - companionSizeDip.height);

  const clampedX = Math.max(minX, Math.min(targetX, maxX));
  const clampedY = Math.max(minY, Math.min(targetY, maxY));

  return {
    visible: true,
    shouldMove: true,
    boundsDip: {
      x: clampedX,
      y: clampedY,
      width: companionSizeDip.width,
      height: companionSizeDip.height,
    },
  };
}
