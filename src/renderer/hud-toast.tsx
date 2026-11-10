import React, { useEffect, useState } from "react";
import { IconAlert, IconCheck, IconClose } from "./icons";

export interface HudToastProps {
  error?: string;
  notice?: string;
  onClearError: () => void;
  onClearNotice: () => void;
}

export function HudToast({
  error,
  notice,
  onClearError,
  onClearNotice,
}: HudToastProps) {
  const [visible, setVisible] = useState(false);
  const activeMessage = error || notice;
  const isError = Boolean(error);

  useEffect(() => {
    if (activeMessage) {
      setVisible(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setTimeout(() => {
          if (isError) onClearError();
          else onClearNotice();
        }, 200);
      }, 4500);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [activeMessage, isError, onClearError, onClearNotice]);

  if (!activeMessage || !visible) return null;

  return (
    <div
      className={`hud-toast-banner ${isError ? "error" : "notice"} ${
        visible ? "visible" : ""
      }`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="hud-toast-icon">
        {isError ? <IconAlert /> : <IconCheck />}
      </span>
      <span className="hud-toast-message">{activeMessage}</span>
      <button
        type="button"
        className="hud-toast-close"
        onClick={() => {
          setVisible(false);
          setTimeout(() => {
            if (isError) onClearError();
            else onClearNotice();
          }, 150);
        }}
        aria-label="Dismiss notification"
      >
        <IconClose />
      </button>
    </div>
  );
}
