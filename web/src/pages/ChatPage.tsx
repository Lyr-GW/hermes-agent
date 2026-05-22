/**
 * ChatPage — New Agent page (Cursor IDE style).
 *
 * Replaces the legacy xterm.js terminal embed with a chat-first agent
 * workspace: repo + branch selectors → large instruction input →
 * model + MCPs → quick actions → recent activity feed.
 *
 * All sub-components live inline in this file to keep the surface small
 * and obvious; data is mocked pending real API wiring. The parent
 * (`App.tsx`) still mounts this component persistently and passes
 * `isActive`, so the prop is accepted but unused.
 *
 * Design spec: ~/Documents/Code/hermes-dashboard/new-design/DESIGN.md
 */

import {
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Mic,
  PlayCircle,
  RotateCw,
  Search,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { PluginSlot } from "@/plugins";

// ============================================================
// Types
// ============================================================

interface Repo {
  id: string;
  name: string;
  fullName?: string;
  defaultBranch?: string;
}

interface Model {
  id: string;
  name: string;
  provider?: string;
  isDefault?: boolean;
}

interface ConversationItem {
  id: string;
  title: string;
  branchName?: string;
  additions: number;
  deletions: number;
}

interface AgentGroup {
  label: string;
  conversations: ConversationItem[];
}

type ActivityStatus = "draft" | "branch" | "running" | "completed" | "failed";

interface Activity {
  id: string;
  status: ActivityStatus;
  statusLabel: string;
  title: string;
  modelName: string;
  repoName: string;
  timestamp: string;
  additions?: number;
  deletions?: number;
}

type DataStatus = "loading" | "empty" | "error" | "ready";

// ============================================================
// Mock data — replace with real API calls in Phase 4.
// ============================================================

const MOCK_REPOS: Repo[] = [
  {
    id: "1",
    name: "MindIE-PyMotor",
    fullName: "lyr-gw/mindie-pymotor",
    defaultBranch: "master",
  },
  {
    id: "2",
    name: "hermes-agent",
    fullName: "NousResearch/hermes-agent",
    defaultBranch: "main",
  },
  {
    id: "3",
    name: "hermes-dashboard",
    fullName: "lyr-gw/hermes-dashboard",
    defaultBranch: "main",
  },
];

const MOCK_BRANCHES: string[] = [
  "master",
  "dev",
  "feat/inference-cache",
  "feat/cursor-redesign",
  "hotfix/oom-batch-32",
];

const MOCK_MODELS: Model[] = [
  { id: "opus-4.7-high", name: "Opus 4.7 High", provider: "Anthropic", isDefault: true },
  { id: "sonnet-4.5", name: "Sonnet 4.5", provider: "Anthropic" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "OpenAI" },
  { id: "gemini-2.5-ultra", name: "Gemini 2.5 Ultra", provider: "Google" },
];

const MOCK_ACTIVITIES: Activity[] = [
  {
    id: "a1",
    status: "branch",
    statusLabel: "Branch",
    title: "Fix memory leak in inference engine when batch size exceeds 32",
    modelName: "Opus 4.7",
    repoName: "lyr-gw/mindie-pymotor",
    timestamp: "2 hours ago",
    additions: 1184,
    deletions: 43,
  },
  {
    id: "a2",
    status: "completed",
    statusLabel: "Completed",
    title: "Add KV cache affinity routing for multi-GPU deployment",
    modelName: "Opus 4.7",
    repoName: "lyr-gw/mindie-pymotor",
    timestamp: "Yesterday",
    additions: 489,
    deletions: 12,
  },
  {
    id: "a3",
    status: "draft",
    statusLabel: "Draft",
    title: "Refactor conductor registration to support dynamic endpoints",
    modelName: "Sonnet 4.5",
    repoName: "lyr-gw/mindie-pymotor",
    timestamp: "2 days ago",
  },
  {
    id: "a4",
    status: "running",
    statusLabel: "Running",
    title: "Implement function-call affinity benchmark suite",
    modelName: "GPT-5.5",
    repoName: "NousResearch/hermes-agent",
    timestamp: "3 days ago",
    additions: 256,
    deletions: 8,
  },
  {
    id: "a5",
    status: "failed",
    statusLabel: "Failed",
    title: "Migrate legacy session store from sqlite to postgres",
    modelName: "Opus 4.7",
    repoName: "lyr-gw/hermes-dashboard",
    timestamp: "5 days ago",
  },
];

/** Mock sidebar conversations — includes noise entries for filtering demo. */
const MOCK_AGENTS: AgentGroup[] = [
  {
    label: "Cursor Agents",
    conversations: [
      { id: "c1", title: "Fix memory leak in inference engine when batch size exceeds 32", branchName: "fix/memory-leak", additions: 1184, deletions: 43 },
      { id: "c2", title: "Add KV cache affinity routing for multi-GPU deployment", branchName: "feat/kv-cache", additions: 489, deletions: 12 },
      { id: "c3", title: "Refactor conductor registration to support dynamic endpoints", branchName: "cursor/conductor-registration", additions: 256, deletions: 8 },
      { id: "c4", title: "Implement function-call affinity benchmark suite", branchName: "feat/fn-benchmark", additions: 320, deletions: 89 },
      { id: "noise1", title: "Untitled", additions: 0, deletions: 0 },
      { id: "noise2", title: "20260521_auto_setup", additions: 5, deletions: 2 },
    ],
  },
  {
    label: "Hermes Agents",
    conversations: [
      { id: "c5", title: "Optimize flash attention v2 kernel", branchName: "optim/flash-attn", additions: 320, deletions: 89 },
      { id: "c6", title: "Migrate legacy session store from sqlite to postgres", branchName: "migrate/session-store", additions: 89, deletions: 15 },
      { id: "noise3", title: "20260522_temp_cleanup", additions: 0, deletions: 0 },
    ],
  },
];

// ============================================================
// useClickOutside — close dropdowns on outside click
// ============================================================

function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

// ============================================================
// InlineDropdown — text + ▼ trigger with menu; handles
// loading/empty/error states so callers stay simple.
// ============================================================

interface InlineDropdownProps<T> {
  selectedLabel: string;
  items: T[];
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  itemSecondary?: (item: T) => string | undefined;
  onSelect: (item: T) => void;
  status: DataStatus;
  emptyText?: string;
  errorText?: string;
  onRetry?: () => void;
  skeletonWidth?: number;
  menuMinWidth?: number;
  ariaLabel?: string;
}

function InlineDropdown<T>({
  selectedLabel,
  items,
  itemKey,
  itemLabel,
  itemSecondary,
  onSelect,
  status,
  emptyText = "No items.",
  errorText = "Failed to load.",
  onRetry,
  skeletonWidth = 140,
  menuMinWidth = 220,
  ariaLabel,
}: InlineDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  if (status === "loading") {
    return (
      <div
        className="inline-block h-5 animate-pulse rounded bg-[#e8e8e8]"
        style={{ width: skeletonWidth }}
        aria-busy="true"
        aria-label={ariaLabel ? `Loading ${ariaLabel}` : "Loading"}
      />
    );
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-2 text-[13px] text-red-500">
        <span>{errorText}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            <RotateCw className="h-3 w-3" /> Retry
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
          "text-[13px] font-normal text-[#1a1a1a] transition-colors",
          "hover:bg-[#e8e8e8] focus:outline-none focus:ring-1 focus:ring-[#bdbdbd]",
        )}
      >
        <span className="max-w-[220px] truncate">{selectedLabel}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-[#666] transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-[#e0e0e0] bg-white py-1 shadow-lg"
          style={{ minWidth: menuMinWidth }}
        >
          {items.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[#999]">
              {emptyText}
            </div>
          ) : (
            items.map((item) => (
              <button
                key={itemKey(item)}
                type="button"
                role="option"
                onClick={() => {
                  onSelect(item);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[13px] text-[#1a1a1a] transition-colors hover:bg-[#f5f5f5]"
              >
                <span>{itemLabel(item)}</span>
                {itemSecondary?.(item) && (
                  <span className="text-[11px] text-[#999]">
                    {itemSecondary(item)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// AgentSidebar — Cursor-style left panel with New Agent button,
// collapsible Cursor/Hermes groups, and noise-filtered list.
// ============================================================

function AgentSidebar() {
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const newAgentRef = useRef<HTMLDivElement>(null);
  useClickOutside(newAgentRef, () => setNewAgentOpen(false));

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return MOCK_AGENTS
      .map((g) => ({
        ...g,
        conversations: g.conversations.filter((c) => {
          // Filter system noise
          if (c.title === "Untitled") return false;
          if (/^\d{8}_/.test(c.title)) return false;
          // Search filter
          if (!q) return true;
          return (
            c.title.toLowerCase().includes(q) ||
            (c.branchName ?? "").toLowerCase().includes(q)
          );
        }),
      }))
      .filter((g) => g.conversations.length > 0);
  }, [search]);

  return (
    <aside
      className="flex w-[260px] shrink-0 flex-col border-r border-[#e0e0e0]"
      style={{ backgroundColor: "#f8f8f8" }}
    >
      {/* ---- New Agent button ---- */}
      <div className="p-3" ref={newAgentRef}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setNewAgentOpen((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg",
              "px-3.5 py-2 text-[13px] font-semibold text-[#1a1a1a]",
              "transition-colors",
              "bg-[#eaeaea] hover:bg-[#e0e0e0]",
            )}
          >
            <span>New Agent</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-[#666] transition-transform",
                newAgentOpen && "rotate-180",
              )}
            />
          </button>

          {newAgentOpen && (
            <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-[#e0e0e0] bg-white py-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[#1a1a1a] transition-colors hover:bg-[#f5f5f5]"
                onClick={() => {
                  console.info("[ChatPage] New Cursor Agent");
                  setNewAgentOpen(false);
                }}
              >
                <span className="text-[#3b82f6]">✦</span>
                New Cursor Agent
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[#1a1a1a] transition-colors hover:bg-[#f5f5f5]"
                onClick={() => {
                  console.info("[ChatPage] New Hermes Agent");
                  setNewAgentOpen(false);
                }}
              >
                <span className="text-[#22c55e]">✦</span>
                New Hermes Agent
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Search ---- */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#999]" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 pl-8 pr-3 text-[12px] border border-[#e0e0e0] rounded outline-none focus:border-[#bdbdbd] transition-colors bg-white"
          />
        </div>
      </div>

      {/* ---- Collapsible groups ---- */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[12px] text-[#999] px-4 text-center">
            No conversations found.
          </div>
        ) : (
          <div className="py-1">
            {filtered.map((group) => {
              const isCollapsed = collapsed.has(group.label);
              return (
                <div key={group.label}>
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(group.label)}
                    className={cn(
                      "flex items-center gap-1.5 w-full px-3 py-2",
                      "text-[11px] font-semibold text-[#1a1a1a]",
                      "hover:bg-[#eaeaea] transition-colors",
                      "tracking-wider uppercase",
                    )}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 text-[#999]" />
                    ) : (
                      <ChevronDown className="h-3 w-3 text-[#999]" />
                    )}
                    <Folder className="h-3.5 w-3.5 text-[#666]" />
                    <span className="truncate">{group.label}</span>
                  </button>

                  {/* Conversation items */}
                  {!isCollapsed && (
                    <div>
                      {group.conversations.map((conv) => (
                        <button
                          key={conv.id}
                          onClick={() =>
                            console.info("[ChatPage] select conversation", conv.id)
                          }
                          className={cn(
                            "flex items-center gap-2 w-full px-3 py-1.5 text-[12px] transition-colors",
                            "hover:bg-[#eaeaea]",
                          )}
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#666]" />
                          <span className="truncate flex-1 text-left text-[#1a1a1a]">
                            {conv.title}
                          </span>
                          <span className="shrink-0 text-[11px] space-x-1">
                            {conv.additions > 0 && (
                              <span className="text-[#22c55e]">
                                +{conv.additions}
                              </span>
                            )}
                            {conv.deletions > 0 && (
                              <span className="text-[#ef4444]">
                                -{conv.deletions}
                              </span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- User info footer ---- */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-t border-[#e0e0e0]">
        <div className="h-6 w-6 rounded-full bg-[#3b82f6] flex items-center justify-center text-white text-[11px] font-semibold shrink-0">
          W
        </div>
        <span className="text-[12px] font-medium text-[#1a1a1a]">Wei Lin</span>
        <span className="ml-auto text-[10px] font-medium text-[#666] bg-[#eaeaea] rounded px-1.5 py-0.5">
          Ultra
        </span>
      </div>
    </aside>
  );
}

// ============================================================
// QuickButton — pill-style preset action
// ============================================================

function QuickButton({
  label,
  suffix,
  onClick,
}: {
  label: string;
  suffix?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-[#e0e0e0]",
        "bg-white px-3.5 py-1.5 text-[13px] text-[#666] transition-all",
        "hover:border-[#bdbdbd] hover:bg-[#fafafa] hover:shadow-sm",
      )}
    >
      <span>{label}</span>
      {suffix && (
        <span className="inline-flex items-center rounded border border-[#e0e0e0] px-1.5 py-0.5 font-mono text-[11px] text-[#999]">
          {suffix}
        </span>
      )}
    </button>
  );
}

// ============================================================
// RecentActivityList & Card
// ============================================================

const STATUS_META: Record<
  ActivityStatus,
  { icon: ComponentType<{ className?: string }>; color: string; bg: string }
> = {
  draft: { icon: FileText, color: "#666", bg: "#e8e8e8" },
  branch: { icon: GitBranch, color: "#3b82f6", bg: "#dbeafe" },
  running: { icon: PlayCircle, color: "#eab308", bg: "#fef9c3" },
  completed: { icon: CheckCircle2, color: "#22c55e", bg: "#dcfce7" },
  failed: { icon: XCircle, color: "#ef4444", bg: "#fee2e2" },
};

function RecentActivityCard({
  activity,
  onClick,
}: {
  activity: Activity;
  onClick?: (activity: Activity) => void;
}) {
  const meta = STATUS_META[activity.status];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={() => onClick?.(activity)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-[#e0e0e0] bg-white px-4 py-3 text-left",
        "transition-all hover:border-[#bdbdbd] hover:shadow-sm",
      )}
    >
      <span
        className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium"
        style={{ backgroundColor: meta.bg, color: meta.color }}
      >
        <Icon className="h-3 w-3" />
        <span>{activity.statusLabel}</span>
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[14px] font-semibold text-[#1a1a1a]">
          {activity.title}
        </span>
        <span className="text-[12px] text-[#666]">
          {activity.modelName}
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[#999]">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {activity.timestamp}
          </span>
          <span aria-hidden>·</span>
          <span className="truncate">{activity.repoName}</span>
          {(activity.additions !== undefined ||
            activity.deletions !== undefined) && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-2 font-mono text-[11px]">
                {activity.additions !== undefined && (
                  <span className="text-green-500">+{activity.additions}</span>
                )}
                {activity.deletions !== undefined && (
                  <span className="text-red-500">-{activity.deletions}</span>
                )}
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function RecentActivityList({
  status,
  activities,
  onRetry,
  onCardClick,
}: {
  status: DataStatus;
  activities: Activity[];
  onRetry?: () => void;
  onCardClick?: (activity: Activity) => void;
}) {
  if (status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg border border-[#e0e0e0] bg-white"
          />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-[#e0e0e0] bg-white py-8 text-[13px] text-red-500"
      >
        <span>Failed to load recent activity.</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12px] text-blue-500 transition-colors hover:underline"
          >
            <RotateCw className="h-3 w-3" /> Retry
          </button>
        )}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="rounded-lg border border-[#e0e0e0] bg-white px-6 py-10 text-center text-[13px] text-[#999]">
        No recent activity. Start a new task above.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {activities.map((a) => (
        <li key={a.id}>
          <RecentActivityCard activity={a} onClick={onCardClick} />
        </li>
      ))}
    </ul>
  );
}

// ============================================================
// ChatPage — page entry point
// ============================================================

// `isActive` accepted to preserve App.tsx's call signature; the new
// page is stateless w.r.t. activation (no PTY to suspend), so we
// don't read it.
export default function ChatPage(_props: { isActive?: boolean } = {}) {
  // Repos
  const [reposStatus, setReposStatus] = useState<DataStatus>("loading");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);

  // Branches (depend on selectedRepo)
  const [branchesStatus, setBranchesStatus] = useState<DataStatus>("loading");
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("");

  // Models
  const [modelsStatus, setModelsStatus] = useState<DataStatus>("loading");
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);

  // Recent activity
  const [activitiesStatus, setActivitiesStatus] = useState<DataStatus>("loading");
  const [activities, setActivities] = useState<Activity[]>([]);

  // Instruction input
  const [instruction, setInstruction] = useState("");

  // MCPs dropdown
  const mcpsRef = useRef<HTMLDivElement>(null);
  const [mcpsOpen, setMcpsOpen] = useState(false);
  useClickOutside(mcpsRef, () => setMcpsOpen(false));

  // Mock fetchers — small setTimeout to exercise the loading state
  const loadRepos = useCallback(() => {
    setReposStatus("loading");
    const t = setTimeout(() => {
      setRepos(MOCK_REPOS);
      setSelectedRepo(MOCK_REPOS[0] ?? null);
      setReposStatus("ready");
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const loadBranches = useCallback((_repoId: string) => {
    setBranchesStatus("loading");
    const t = setTimeout(() => {
      setBranches(MOCK_BRANCHES);
      setSelectedBranch(MOCK_BRANCHES[0] ?? "");
      setBranchesStatus("ready");
    }, 150);
    return () => clearTimeout(t);
  }, []);

  const loadModels = useCallback(() => {
    setModelsStatus("loading");
    const t = setTimeout(() => {
      setModels(MOCK_MODELS);
      setSelectedModel(MOCK_MODELS.find((m) => m.isDefault) ?? MOCK_MODELS[0] ?? null);
      setModelsStatus("ready");
    }, 220);
    return () => clearTimeout(t);
  }, []);

  const loadActivities = useCallback(() => {
    setActivitiesStatus("loading");
    const t = setTimeout(() => {
      setActivities(MOCK_ACTIVITIES);
      setActivitiesStatus("ready");
    }, 280);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const cleanups = [loadRepos(), loadModels(), loadActivities()];
    return () => cleanups.forEach((c) => c?.());
  }, [loadRepos, loadModels, loadActivities]);

  useEffect(() => {
    if (!selectedRepo) return;
    return loadBranches(selectedRepo.id);
  }, [selectedRepo, loadBranches]);

  const handleSubmit = useCallback(() => {
    if (!instruction.trim()) return;
    // TODO: POST /api/chat then navigate to /sessions?id=<new>
    console.info("[ChatPage] submit", {
      instruction,
      repo: selectedRepo?.fullName ?? selectedRepo?.name,
      branch: selectedBranch,
      model: selectedModel?.id,
    });
  }, [instruction, selectedRepo, selectedBranch, selectedModel]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col font-sans normal-case antialiased"
      style={{ backgroundColor: "#f5f5f5", color: "#1a1a1a" }}
    >
      <PluginSlot name="chat:top" />

      <div className="flex min-h-0 flex-1">
        {/* ---- Cursor-style left sidebar ---- */}
        <AgentSidebar />

        {/* ---- Main content area ---- */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
            {/* 1. Repo / Branch selectors */}
            <header className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
              <InlineDropdown<Repo>
                ariaLabel="Repository"
                selectedLabel={selectedRepo?.name ?? "Select repo"}
                items={repos}
                itemKey={(r) => r.id}
                itemLabel={(r) => r.name}
                itemSecondary={(r) => r.fullName}
                onSelect={(r) => setSelectedRepo(r)}
                status={reposStatus}
                emptyText="No repositories found."
                errorText="Failed to load repos."
                onRetry={loadRepos}
                skeletonWidth={160}
                menuMinWidth={260}
              />
              <span aria-hidden className="text-[#999]">/</span>
              <div className="inline-flex items-center gap-1">
                <GitBranch
                  className="h-3.5 w-3.5 text-[#666]"
                  aria-hidden
                />
                <InlineDropdown<string>
                  ariaLabel="Branch"
                  selectedLabel={selectedBranch || "Select branch"}
                  items={branches}
                  itemKey={(b) => b}
                  itemLabel={(b) => b}
                  onSelect={(b) => setSelectedBranch(b)}
                  status={branchesStatus}
                  emptyText="No branches found."
                  errorText="Failed to load branches."
                  onRetry={() => selectedRepo && loadBranches(selectedRepo.id)}
                  skeletonWidth={120}
                  menuMinWidth={220}
                />
              </div>
            </header>

            {/* 2. Large instruction input */}
            <section
              className="relative rounded-xl border border-[#e0e0e0] bg-white transition-all focus-within:border-[#bdbdbd] focus-within:shadow-sm"
            >
              <label htmlFor="chat-instruction" className="sr-only">
                Instruction
              </label>
              <textarea
                id="chat-instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Cursor to build, fix bugs, explore"
                rows={4}
                className={cn(
                  "block w-full resize-none rounded-xl bg-transparent",
                  "px-4 py-3 pr-24 text-[14px] leading-relaxed",
                  "placeholder:text-[#999] focus:outline-none",
                  "text-[#1a1a1a]",
                )}
                style={{ minHeight: 120 }}
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Attach image"
                  title="Attach image"
                  className="rounded p-1.5 text-[#999] transition-colors hover:bg-[#f0f0f0]"
                >
                  <ImageIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="Voice input"
                  title="Voice input"
                  className="rounded p-1.5 text-[#999] transition-colors hover:bg-[#f0f0f0]"
                >
                  <Mic className="h-4 w-4" />
                </button>
              </div>
            </section>

            {/* 3. Model selector + MCPs */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <InlineDropdown<Model>
                ariaLabel="Model"
                selectedLabel={selectedModel?.name ?? "Select model"}
                items={models}
                itemKey={(m) => m.id}
                itemLabel={(m) => m.name}
                itemSecondary={(m) => m.provider}
                onSelect={(m) => setSelectedModel(m)}
                status={modelsStatus}
                emptyText="No models available."
                errorText="Failed to load models."
                onRetry={loadModels}
                skeletonWidth={140}
                menuMinWidth={220}
              />
              <div className="relative inline-block" ref={mcpsRef}>
                <button
                  type="button"
                  onClick={() => setMcpsOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={mcpsOpen}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
                    "text-[13px] font-normal text-[#1a1a1a] transition-colors",
                    "hover:bg-[#e8e8e8] focus:outline-none focus:ring-1 focus:ring-[#bdbdbd]",
                  )}
                >
                  <span>MCPs</span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 text-[#666] transition-transform",
                      mcpsOpen && "rotate-180",
                    )}
                  />
                </button>
                {mcpsOpen && (
                  <div className="absolute left-0 z-30 mt-1 w-56 rounded-lg border border-[#e0e0e0] bg-white p-3 text-[12px] text-[#666] shadow-lg">
                    No MCP servers configured.
                  </div>
                )}
              </div>
            </div>

            {/* 4. Quick action buttons */}
            <div className="flex flex-wrap gap-3">
              <QuickButton
                label="Try Commands"
                suffix="Press /"
                onClick={() => setInstruction((prev) => (prev ? prev : "/"))}
              />
              <QuickButton
                label="Run security audit"
                onClick={() =>
                  setInstruction(
                    "Run a security audit on the current branch and report all critical issues with file references.",
                  )
                }
              />
            </div>

            {/* 5. Recent activity */}
            <section className="mt-2 flex flex-col gap-3">
              <h2 className="text-[11px] font-semibold tracking-[0.08em] text-[#666]">
                RECENT ACTIVITY
              </h2>
              <RecentActivityList
                status={activitiesStatus}
                activities={activities}
                onRetry={loadActivities}
                onCardClick={(a) =>
                  console.info("[ChatPage] open activity", a.id)
                }
              />
            </section>
          </div>
        </div>
      </div>

      <PluginSlot name="chat:bottom" />
    </div>
  );
}
