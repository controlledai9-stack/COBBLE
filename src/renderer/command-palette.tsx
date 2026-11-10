import React, { useState, useEffect, useRef, useMemo } from "react";
import type { AppState, Tab } from "../shared/types";
import {
  IconSearch,
  IconHome,
  IconChats,
  IconTeams,
  IconInvites,
  IconProfile,
  IconActivity,
  IconSun,
  IconMoon,
  IconExternal,
  IconPlus,
  IconCheck,
  IconCommand,
} from "./icons";

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  state: AppState;
  currentTab: Tab;
  onSelectTab: (tab: Tab) => void;
  onSelectTeam: (teamId: string) => void;
  onToggleTheme: () => void;
  theme: "light" | "dark";
  onScanWorkspace: () => void;
  onTogglePause: () => void;
  onSummonPebble: () => void;
  onOpenWorkspaceModal: () => void;
  onOpenMiniChat: () => void;
  onExportReport: () => void;
}

interface CommandItem {
  id: string;
  category: "Navigation" | "Workspaces" | "Actions";
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
  active?: boolean;
}

export function CommandPalette({
  isOpen,
  onClose,
  state,
  currentTab,
  onSelectTab,
  onSelectTeam,
  onToggleTheme,
  theme,
  onScanWorkspace,
  onTogglePause,
  onSummonPebble,
  onOpenWorkspaceModal,
  onOpenMiniChat,
  onExportReport,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isMac = useMemo(
    () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform),
    [],
  );
  const metaKey = isMac ? "⌘" : "Ctrl+";

  const allCommands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      // Navigation
      {
        id: "nav-overview",
        category: "Navigation",
        title: "Overview",
        subtitle: "View live workspace signals, recent activity & coverage",
        icon: <IconHome />,
        shortcut: `${metaKey}1`,
        action: () => onSelectTab("Home"),
        active: currentTab === "Home",
      },
      {
        id: "nav-discussions",
        category: "Navigation",
        title: "Discussions",
        subtitle: "Team chat, private messages & voice drafts",
        icon: <IconChats />,
        shortcut: `${metaKey}2`,
        action: () => onSelectTab("Chats"),
        active: currentTab === "Chats",
      },
      {
        id: "nav-teams",
        category: "Navigation",
        title: "Workspace & Plan",
        subtitle: "Core plan, milestones, ownership map & proposals",
        icon: <IconTeams />,
        shortcut: `${metaKey}3`,
        action: () => onSelectTab("Teams"),
        active: currentTab === "Teams",
      },
      {
        id: "nav-invites",
        category: "Navigation",
        title: "Join Requests",
        subtitle: "Incoming applicant requests & mesh invitations",
        icon: <IconInvites />,
        shortcut: `${metaKey}4`,
        action: () => onSelectTab("Invites"),
        active: currentTab === "Invites",
      },
      {
        id: "nav-profile",
        category: "Navigation",
        title: "Profile & Settings",
        subtitle: "Developer identity, voice engine, appearance & IDEs",
        icon: <IconProfile />,
        shortcut: `${metaKey},`,
        action: () => onSelectTab("Profile"),
        active: currentTab === "Profile",
      },
    ];

    // Workspaces
    for (const team of state.teams) {
      const isActive = team.id === state.activeTeamId;
      items.push({
        id: `team-${team.id}`,
        category: "Workspaces",
        title: team.name,
        subtitle: team.workspace ? `Watched: ${team.workspace}` : "No folder chosen yet",
        icon: <IconTeams />,
        active: isActive,
        action: () => {
          onSelectTeam(team.id);
          onSelectTab("Teams");
        },
      });
    }

    // Actions
    items.push({
      id: "act-new-workspace",
      category: "Workspaces",
      title: "Create New or Join Workspace…",
      subtitle: "Initialize a local project team or join via invite code",
      icon: <IconPlus />,
      action: onOpenWorkspaceModal,
    });

    items.push({
      id: "act-scan",
      category: "Actions",
      title: "Scan Workspace for File Changes",
      subtitle: "Execute immediate observation pass on watched project folder",
      icon: <IconActivity />,
      action: onScanWorkspace,
    });

    items.push({
      id: "act-pause",
      category: "Actions",
      title: state.paused ? "Resume File Observation" : "Pause File Observation",
      subtitle: state.paused
        ? "Re-enable live background file watcher and conflict triage"
        : "Temporarily pause file watching without disconnecting",
      icon: <IconActivity />,
      action: onTogglePause,
    });

    items.push({
      id: "act-theme",
      category: "Actions",
      title: theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode",
      subtitle: theme === "dark" ? "Clean Apple crisp white theme" : "High contrast zinc-black dark theme",
      icon: theme === "dark" ? <IconSun /> : <IconMoon />,
      shortcut: `${metaKey}D`,
      action: onToggleTheme,
    });

    items.push({
      id: "act-pebble",
      category: "Actions",
      title: "Summon Pebble Desktop Companion",
      subtitle: "Open ambient co-pilot window with edge docking and voice controls",
      icon: <IconExternal />,
      action: onSummonPebble,
    });

    items.push({
      id: "act-mini-chat",
      category: "Actions",
      title: "Pop Out Mini-Chat Window",
      subtitle: "Detach floating chat communicator for side-by-side coding",
      icon: <IconChats />,
      action: onOpenMiniChat,
    });

    items.push({
      id: "act-report",
      category: "Actions",
      title: "Export Session Summary Report",
      subtitle: "Download local markdown report of activities and plan state",
      icon: <IconExternal />,
      action: onExportReport,
    });

    return items;
  }, [
    state.teams,
    state.activeTeamId,
    state.paused,
    currentTab,
    theme,
    metaKey,
    onSelectTab,
    onSelectTeam,
    onOpenWorkspaceModal,
    onScanWorkspace,
    onTogglePause,
    onToggleTheme,
    onSummonPebble,
    onOpenMiniChat,
    onExportReport,
  ]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.subtitle && c.subtitle.toLowerCase().includes(q)) ||
        c.category.toLowerCase().includes(q),
    );
  }, [allCommands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) =>
          filteredCommands.length > 0 ? (i + 1) % filteredCommands.length : 0,
        );
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) =>
          filteredCommands.length > 0
            ? (i - 1 + filteredCommands.length) % filteredCommands.length
            : 0,
        );
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const selected = filteredCommands[selectedIndex];
        if (selected) {
          selected.action();
          onClose();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, filteredCommands, selectedIndex, onClose]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(".command-palette-item.selected");
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="command-palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div className="command-palette-container">
        <div className="command-palette-header">
          <IconSearch className="command-palette-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, search workspaces, or jump to a tab…"
            aria-label="Search commands and workspaces"
          />
          <kbd className="command-palette-esc-badge" onClick={onClose}>
            ESC
          </kbd>
        </div>

        <div className="command-palette-list" ref={listRef}>
          {filteredCommands.length === 0 ? (
            <div className="command-palette-empty">
              <span>No matching commands found</span>
              <small>Try typing "plan", "chat", "dark", or "scan"</small>
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={cmd.id}
                  className={`command-palette-item ${isSelected ? "selected" : ""} ${
                    cmd.active ? "active-entity" : ""
                  }`}
                  onClick={() => {
                    cmd.action();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="command-palette-item-icon">{cmd.icon}</span>
                  <div className="command-palette-item-text">
                    <div className="command-palette-item-title">
                      <span>{cmd.title}</span>
                      {cmd.active && (
                        <span className="command-palette-active-pill">
                          <IconCheck /> Current
                        </span>
                      )}
                    </div>
                    {cmd.subtitle && (
                      <span className="command-palette-item-subtitle">
                        {cmd.subtitle}
                      </span>
                    )}
                  </div>
                  {cmd.shortcut && (
                    <kbd className="command-palette-shortcut-badge">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="command-palette-footer">
          <div className="command-palette-tips">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> to navigate
            </span>
            <span>
              <kbd>↵</kbd> to select
            </span>
            <span>
              <kbd>esc</kbd> to close
            </span>
          </div>
          <span className="command-palette-brand">
            <IconCommand /> Cobble Spotlight
          </span>
        </div>
      </div>
    </div>
  );
}
