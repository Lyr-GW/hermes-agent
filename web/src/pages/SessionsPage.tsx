import { useState, useRef, useEffect, useMemo } from "react";
import {
  Search,
  GitBranch,
  Folder,
  Paperclip,
  Mic,
  Send,
  ChevronDown,
  ChevronRight,
  PanelRightOpen,
  PanelRightClose,
  FileCode,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@nous-research/ui/ui/components/badge";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ConversationItem {
  id: string;
  title: string;
  branchName?: string;
  additions: number;
  deletions: number;
}

interface ConversationGroup {
  repoName: string;
  conversations: ConversationItem[];
  collapsed?: boolean;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  modelName?: string;
}

interface DiffFileData {
  fileName: string;
  additions: number;
  deletions: number;
  diffContent: string;
  language?: string;
  expanded?: boolean;
}

interface GitDiffData {
  prNumber: number;
  prStatus: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  files: DiffFileData[];
}

/* ------------------------------------------------------------------ */
/*  Mock Data                                                          */
/* ------------------------------------------------------------------ */

/**
 * Conversations grouped by agent type (Cursor vs Hermes).
 * Includes noise entries (Untitled, date-prefixed) for the
 * sidebar's noise-filtering logic to demonstrate filtering.
 */
const MOCK_GROUPS: ConversationGroup[] = [
  {
    repoName: "Cursor Agents",
    conversations: [
      { id: "s1", title: "Kv cache affinity issue", branchName: "cursor/kv-cache", additions: 1184, deletions: 43 },
      { id: "s2", title: "Fix tensor shape mismatch in attention", branchName: "cursor/tensor-fix", additions: 56, deletions: 12 },
      { id: "s3", title: "Optimize flash attention v2 kernel", branchName: "cursor/flash-attn", additions: 320, deletions: 89 },
      { id: "noise1", title: "Untitled", additions: 0, deletions: 0 },
      { id: "noise2", title: "20260521_auto_cleanup", additions: 5, deletions: 2 },
    ],
  },
  {
    repoName: "Hermes Agents",
    conversations: [
      { id: "s4", title: "Add streaming tool call support", branchName: "feat/streaming", additions: 245, deletions: 30 },
      { id: "s5", title: "Refactor skill loading pipeline", branchName: "refactor/skills", additions: 0, deletions: 0 },
      { id: "s6", title: "Update neovim lsp config", branchName: "dotfiles/nvim", additions: 89, deletions: 15 },
      { id: "noise3", title: "20260522_temp_migration", additions: 0, deletions: 0 },
    ],
  },
];

const MOCK_USER_MSG =
  "I'm seeing a performance regression in the kv cache after the latest merge. The throughput dropped by about 15% on H100. Can you trace where the bottleneck might be?";

const MOCK_ASSISTANT_MSG = `Looking at the kv cache allocation in \`src/attention/cache.py\`, I suspect the issue is in the **page table fragmentation**. Let me trace through the allocation path:

\`\`\`python
# src/attention/cache.py:142-168
class PagedKVCache:
    def allocate(self, num_tokens: int) -> List[int]:
        # New block allocation
        blocks_needed = ceil_div(num_tokens, BLOCK_SIZE)
        # BUG: This doesn't account for partial blocks at the end of a sequence
        available = self._free_list[:blocks_needed]
        if len(available) < blocks_needed:
            # Triggers compaction — very expensive on H100
            self._compact()  # <-- This is the bottleneck
        return available
\`\`\`

The compaction path is being triggered because the free list is fragmented. Here's the call frequency:

| Metric | Before merge | After merge | Delta |
|--------|-------------|-------------|-------|
| Allocs/sec | 1,240 | 1,980 | +60% |
| Compactions/sec | 2 | 47 | **+2250%** |
| Avg latency/alloc | 12μs | 38μs | +217% |

> **Key insight**: The new prefix caching in PR #12 allocates blocks in a pattern that fragments the free list much faster. The compaction O(n²) behavior is the culprit.

**Suggested fix**: Replace the linear scan in \`_compact()\` with a segment tree, or increase \`BLOCK_SIZE\` from 64 to 256 to reduce the number of allocations.`;

const MOCK_SYSTEM_MSG =
  "[tool] search_code('src/attention/cache.py', query='compaction|free_list')\n  → Found 3 matches in 2 files\n[tool] read_file('src/attention/cache.py', lines='140-180')\n  → 40 lines returned";

const MOCK_MESSAGES: Message[] = [
  { role: "user", content: MOCK_USER_MSG, timestamp: "2 min ago" },
  { role: "assistant", content: MOCK_ASSISTANT_MSG, timestamp: "1 min ago", modelName: "GPT-5.5 High" },
  { role: "system", content: MOCK_SYSTEM_MSG, timestamp: "45 sec ago" },
];

const MOCK_DIFF: GitDiffData = {
  prNumber: 12,
  prStatus: "draft",
  sourceBranch: "cursor/conductor-registration",
  targetBranch: "cursor/function-call-affinity-integration",
  files: [
    {
      fileName: "src/agent/core.py",
      additions: 45,
      deletions: 3,
      language: "python",
      diffContent: `@@ -142,7 +142,9 @@ class AgentCore:
         self._register_tools()
         self._init_context()
+        self._init_conductor_client()
         logger.info("AgentCore initialized")
 
     def process_message(self, msg):
+        if self.conductor:
+            return self.conductor.route(msg)
         return self._default_handler(msg)`,
    },
    {
      fileName: "src/conductor/client.py",
      additions: 120,
      deletions: 0,
      language: "python",
      diffContent: `@@ -0,0 +1,120 @@
+class ConductorClient:
+    def __init__(self, endpoint: str, api_key: str):
+        self.endpoint = endpoint
+        self.session = httpx.AsyncClient(headers={
+            "Authorization": f"Bearer {api_key}"
+        })
+
+    async def route(self, message: str) -> str:
+        resp = await self.session.post(
+            f"{self.endpoint}/v1/route",
+            json={"message": message}
+        )
+        return resp.json()["response"]`,
    },
    {
      fileName: "pyproject.toml",
      additions: 1,
      deletions: 0,
      language: "toml",
      diffContent: `@@ -38,6 +38,7 @@ dependencies = [
     "httpx>=0.27.0",
     "pydantic>=2.0",
+    "conductor-sdk>=0.1.0",
     "rich>=13.0",
 ]`,
    },
  ],
};

const MODELS = [
  { id: "gpt-5.5-high", name: "GPT-5.5 High" },
  { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
  { id: "gpt-5.5-low", name: "GPT-5.5 Low" },
];

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/* ---------- Left: ConversationTree ---------- */

function ConversationTree({
  groups,
  selectedId,
  onSelect,
  loading,
}: {
  groups: ConversationGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const newAgentRef = useRef<HTMLDivElement>(null);

  // Close New Agent dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (newAgentRef.current && !newAgentRef.current.contains(e.target as Node)) {
        setNewAgentOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggleGroup = (repo: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return groups
      .map((g) => ({
        ...g,
        conversations: g.conversations.filter((c) => {
          // Filter system noise: "Untitled" or date-prefixed titles
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
  }, [groups, search]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4 animate-pulse">
        <div className="h-8 bg-gray-200 rounded" />
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-6 bg-gray-100 rounded ml-2" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white">
      {/* ---- New Agent button ---- */}
      <div className="p-3" ref={newAgentRef}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setNewAgentOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg bg-[#eaeaea] px-3.5 py-2 text-[13px] font-semibold text-[#1a1a1a] transition-colors hover:bg-[#e0e0e0]"
          >
            <span>New Agent</span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-[#666] transition-transform ${
                newAgentOpen ? "rotate-180" : ""
              }`}
            />
          </button>

          {newAgentOpen && (
            <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-[#e0e0e0] bg-white py-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[#1a1a1a] transition-colors hover:bg-[#f5f5f5]"
                onClick={() => {
                  console.info("[SessionsPage] New Cursor Agent");
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
                  console.info("[SessionsPage] New Hermes Agent");
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

      {/* Search */}
      <div className="p-3 border-b border-[#e0e0e0] pt-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#999999]" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 pl-8 pr-3 text-xs border border-[#e0e0e0] rounded outline-none focus:border-[#3b82f6] transition-colors"
          />
        </div>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-[#999999] px-4 text-center">
            No conversations found.
          </div>
        ) : (
          <div className="py-1">
            {filtered.map((group) => {
              const collapsed = collapsedRepos.has(group.repoName);
              return (
                <div key={group.repoName}>
                  {/* Group header */}
                  <button
                    onClick={() => toggleGroup(group.repoName)}
                    className="flex items-center gap-1.5 w-full px-3 py-2 text-xs font-semibold text-[#1a1a1a] hover:bg-[#f0f0f0] transition-colors"
                  >
                    {collapsed ? (
                      <ChevronRight className="h-3 w-3 text-[#999999]" />
                    ) : (
                      <ChevronDown className="h-3 w-3 text-[#999999]" />
                    )}
                    <Folder className="h-3.5 w-3.5 text-[#666666]" />
                    <span className="truncate">{group.repoName}</span>
                  </button>

                  {/* Conversations */}
                  {!collapsed && (
                    <div>
                      {group.conversations.map((conv) => {
                        const isSelected = selectedId === conv.id;
                        return (
                          <button
                            key={conv.id}
                            onClick={() => onSelect(conv.id)}
                            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors ${
                              isSelected
                                ? "bg-[#e8e8e8]"
                                : "hover:bg-[#f0f0f0]"
                            }`}
                          >
                            <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#666666]" />
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
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User info footer */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-t border-[#e0e0e0]">
        <div className="h-6 w-6 rounded-full bg-[#3b82f6] flex items-center justify-center text-white text-xs font-semibold shrink-0">
          W
        </div>
        <span className="text-xs font-medium text-[#1a1a1a]">Wei Lin</span>
        <Badge
          tone="secondary"
          className="text-[10px] ml-auto bg-gray-100 text-[#666666]"
        >
          Ultra
        </Badge>
      </div>
    </div>
  );
}

/* ---------- Center: MessageFlow ---------- */

function MessageFlow({
  messages,
  hasSelection,
}: {
  messages: Message[];
  hasSelection: boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const [selectedModel, setSelectedModel] = useState(MODELS[0]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [rightPanelVisible, setRightPanelVisible] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#f5f5f5]">
        <div className="text-center">
          <GitBranch className="h-10 w-10 mx-auto mb-3 text-[#cccccc]" />
          <p className="text-sm text-[#999999]">
            Select a conversation from the sidebar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#e0e0e0] bg-white">
        <Folder className="h-4 w-4 text-[#666666] shrink-0" />
        <span className="text-xs text-[#666666] truncate">
          lyr-gw/mindie-pymotor
        </span>
        <span className="text-[#cccccc] text-xs">/</span>
        <span className="text-xs font-semibold text-[#1a1a1a] truncate">
          Kv cache affinity issue
        </span>
        <button
          onClick={() => setRightPanelVisible((v) => !v)}
          className="ml-auto lg:hidden p-1 hover:bg-[#f0f0f0] rounded transition-colors"
          title={rightPanelVisible ? "Hide diff panel" : "Show diff panel"}
        >
          {rightPanelVisible ? (
            <PanelRightClose className="h-4 w-4 text-[#666666]" />
          ) : (
            <PanelRightOpen className="h-4 w-4 text-[#666666]" />
          )}
        </button>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto bg-[#f5f5f5] px-4"
      >
        <div className="max-w-3xl mx-auto py-4 flex flex-col gap-3">
          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-[#e0e0e0] bg-white px-4 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="relative">
            <input
              type="text"
              placeholder="Add a follow up..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="w-full h-10 pl-4 pr-20 text-sm border border-[#e0e0e0] rounded-lg outline-none focus:border-[#3b82f6] transition-colors bg-white text-[#1a1a1a] placeholder:text-[#999999]"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <button className="p-1.5 hover:bg-[#f0f0f0] rounded transition-colors">
                <Paperclip className="h-4 w-4 text-[#999999]" />
              </button>
              <button className="p-1.5 hover:bg-[#f0f0f0] rounded transition-colors">
                <Mic className="h-4 w-4 text-[#999999]" />
              </button>
            </div>
          </div>

          {/* Model selector + send button */}
          <div className="flex items-center justify-between mt-2">
            <div className="relative">
              <button
                onClick={() => setShowModelPicker((v) => !v)}
                className="flex items-center gap-1 text-xs text-[#666666] hover:text-[#1a1a1a] transition-colors"
              >
                <span>{selectedModel.name}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {showModelPicker && (
                <div className="absolute bottom-full mb-1 left-0 bg-white border border-[#e0e0e0] rounded shadow-sm z-10 min-w-[140px]">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setSelectedModel(m);
                        setShowModelPicker(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#f0f0f0] transition-colors ${
                        selectedModel.id === m.id
                          ? "bg-[#e8e8e8] font-medium"
                          : ""
                      }`}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="h-8 w-8 bg-[#3b82f6] hover:bg-[#2563eb] rounded-lg flex items-center justify-center transition-colors">
              <Send className="h-4 w-4 text-white" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Message Bubble ---------- */

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === "system") {
    return (
      <div className="bg-[#f5f5f5] rounded px-2.5 py-1.5 text-[11px] font-mono text-[#666666] leading-relaxed whitespace-pre-wrap">
        {msg.content}
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="max-w-[70%] self-start">
        <div className="bg-[#f0f0f0] rounded-lg px-3.5 py-2.5 text-sm text-[#1a1a1a] leading-relaxed">
          <Markdown content={msg.content} />
        </div>
        {msg.timestamp && (
          <div className="text-[10px] text-[#999999] mt-1 px-1">{msg.timestamp}</div>
        )}
      </div>
    );
  }

  // assistant
  return (
    <div className="w-full">
      {msg.modelName && (
        <div className="text-[10px] text-[#999999] mb-1 px-1">{msg.modelName}</div>
      )}
      <div
        className="bg-white rounded-lg px-3.5 py-2.5 text-sm text-[#1a1a1a] leading-relaxed"
        style={{ borderLeft: "3px solid #3b82f6" }}
      >
        <Markdown content={msg.content} />
      </div>
      {msg.timestamp && (
        <div className="text-[10px] text-[#999999] mt-1 px-1">{msg.timestamp}</div>
      )}
    </div>
  );
}

/* ---------- Right: GitDiffPanel ---------- */

function GitDiffPanel({ visible }: { visible: boolean }) {
  const [mainTab, setMainTab] = useState<"git" | "desktop" | "terminal">("git");
  const [subTab, setSubTab] = useState<"diff" | "review" | "commits">("diff");
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const toggleFile = (name: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  if (!visible) return null;

  const data = MOCK_DIFF;

  return (
    <div className="w-[400px] shrink-0 border-l border-[#e0e0e0] bg-white flex flex-col overflow-hidden">
      {/* Main tabs */}
      <div className="flex border-b border-[#e0e0e0]">
        {(["git", "desktop", "terminal"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setMainTab(tab)}
            className={`flex-1 text-xs font-medium py-2.5 transition-colors capitalize ${
              mainTab === tab
                ? "text-[#3b82f6] border-b-2 border-[#3b82f6]"
                : "text-[#666666] hover:text-[#1a1a1a]"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* PR Info */}
      <div className="px-3 py-2.5 border-b border-[#e0e0e0]">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-semibold text-[#1a1a1a]">#{data.prNumber}</span>
          <Badge tone="secondary" className="text-[10px] bg-gray-100 text-[#666666]">
            {data.prStatus.charAt(0).toUpperCase() + data.prStatus.slice(1)}
          </Badge>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-mono text-[#666666] truncate">
          <span className="truncate">{data.sourceBranch}</span>
          <span className="text-[#cccccc] shrink-0">→</span>
          <span className="truncate">{data.targetBranch}</span>
        </div>
      </div>

      {/* Sub tabs */}
      <div className="flex border-b border-[#e0e0e0] bg-[#fafafa]">
        {(["diff", "review", "commits"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            className={`px-3 py-1.5 text-[11px] font-medium transition-colors capitalize ${
              subTab === tab
                ? "text-[#3b82f6] border-b-2 border-[#3b82f6]"
                : "text-[#999999] hover:text-[#666666]"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {data.files.map((file) => {
          const expanded = expandedFiles.has(file.fileName);
          return (
            <div key={file.fileName} className="border-b border-[#e0e0e0] last:border-b-0">
              {/* File header */}
              <button
                onClick={() => toggleFile(file.fileName)}
                className="flex items-center gap-2 w-full px-3 py-2 hover:bg-[#f0f0f0] transition-colors"
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-[#999999]" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-[#999999]" />
                )}
                <FileCode className="h-3.5 w-3.5 shrink-0 text-[#666666]" />
                <span className="truncate text-xs text-[#1a1a1a] flex-1 text-left">
                  {file.fileName}
                </span>
                <span className="shrink-0 text-[11px] space-x-1">
                  <span className="text-[#22c55e]">+{file.additions}</span>
                  <span className="text-[#ef4444]">-{file.deletions}</span>
                </span>
              </button>

              {/* Diff content */}
              {expanded && (
                <div className="border-t border-[#e0e0e0] bg-[#fafafa]">
                  {file.diffContent.split("\n").map((line, i) => {
                    let bg = "bg-white";
                    let prefix = " ";
                    if (line.startsWith("+")) {
                      bg = "bg-[#dcfce7]";
                      prefix = "+";
                    } else if (line.startsWith("-")) {
                      bg = "bg-[#fee2e2]";
                      prefix = "-";
                    } else if (line.startsWith("@@")) {
                      bg = "bg-[#eff6ff]";
                      prefix = "";
                    }
                    return (
                      <div
                        key={i}
                        className={`flex text-[11px] font-mono leading-relaxed ${bg}`}
                      >
                        <span className="w-[40px] shrink-0 text-right pr-2 text-[#999999] select-none">
                          {i + 1}
                        </span>
                        <span className="flex-1 whitespace-pre px-1 text-[#1a1a1a]">
                          {prefix}
                          {line.startsWith("@@") ? line : line.slice(1)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function SessionsPage() {
  const [selectedId, setSelectedId] = useState<string>("s1");

  const selectedMessages = useMemo(() => {
    if (!selectedId) return [];
    // Return mock messages for any selected conversation
    return MOCK_MESSAGES;
  }, [selectedId]);

  return (
    <div className="flex h-full w-full bg-[#f5f5f5]">
      {/* Left: ConversationTree (with New Agent button) */}
      <div className="w-[320px] shrink-0 border-r border-[#e0e0e0]">
        <ConversationTree
          groups={MOCK_GROUPS}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Center: MessageFlow */}
      <div className="flex-1 flex flex-col min-w-0">
        <MessageFlow
          messages={selectedMessages}
          hasSelection={selectedId !== null}
        />
      </div>

      {/* Right: GitDiffPanel */}
      <div className="hidden lg:flex">
        <GitDiffPanel visible={true} />
      </div>
    </div>
  );
}
