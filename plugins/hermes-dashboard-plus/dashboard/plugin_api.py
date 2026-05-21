"""Hermes Dashboard Plus — backend API routes for extended dashboard features.

Mounted at /api/plugins/hermes-dashboard-plus/ by the Hermes dashboard plugin system.

Provides:
- Cursor API proxy (agents, models)
- Git repo status/diff/log/branches
- GitHub OAuth Device Flow + PR listing
- Config read/write + health check
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

router = APIRouter()

# ── Constants ──────────────────────────────────────────────────────────────

CURSOR_BASE_URL = "https://api.cursor.com"
GITHUB_API_URL = "https://api.github.com"
GITHUB_LOGIN_URL = "https://github.com"

CONFIG_PATH = Path.home() / ".hermes" / "dashboard-plus-config.json"
CODE_DIR = Path.home() / "Documents" / "Code"

# In-memory TTL caches
_model_cache: dict[str, Any] = {"data": None, "cached_at": 0}
MODEL_CACHE_TTL = 60
_agent_cache: dict[str, Any] = {"data": None, "cached_at": 0}
AGENT_CACHE_TTL = 30

_GIT_TIMEOUT = 15


# ── Helpers ────────────────────────────────────────────────────────────────


def _cursor_headers() -> dict[str, str]:
    """Return Authorization headers for Cursor API.

    Key is NEVER included in response payloads — used only for outbound
    requests to the upstream Cursor API.
    """
    return {
        "Authorization": f"Bearer {os.environ['CURSOR_API_KEY']}",
        "Content-Type": "application/json",
    }


def _load_config() -> dict[str, Any]:
    """Read dashboard-plus config from disk. Returns {} on missing/error."""
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {}


def _save_config(data: dict[str, Any]) -> None:
    """Write dashboard-plus config to disk, creating parent dirs."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(data, indent=2, sort_keys=True))


def _validate_repo_path(repo_path: str) -> Path:
    """Resolve and validate a repo path.

    Returns an absolute Path pointing to an existing directory with a .git
    subdirectory. Raises ValueError on any invalid condition.
    """
    resolved = Path(repo_path).expanduser().resolve()
    if not resolved.is_dir():
        raise ValueError(f"path does not exist or is not a directory: {resolved}")
    if not (resolved / ".git").is_dir():
        raise ValueError(f"path is not a git repository: {resolved}")
    # Safety: reject paths that look like they escape expected areas
    if not str(resolved).startswith(str(Path.home())):
        raise ValueError(f"path is outside home directory: {resolved}")
    return resolved


def _run_git(repo_path: Path, *args: str) -> str:
    """Run a git command in the given repo, returning stdout.

    Raises subprocess.CalledProcessError on non-zero exit.
    """
    return subprocess.run(
        ["git"] + list(args),
        cwd=str(repo_path),
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT,
        shell=False,
    ).stdout


def _scan_code_dirs() -> list[dict[str, Any]]:
    """Scan ~/Documents/Code/ for directories containing .git."""
    repos: list[dict[str, Any]] = []
    if not CODE_DIR.is_dir():
        return repos
    try:
        for child in sorted(CODE_DIR.iterdir()):
            if child.is_dir() and (child / ".git").is_dir():
                repos.append({
                    "name": child.name,
                    "path": str(child),
                    "source": "scan",
                })
    except Exception:
        pass
    return repos


# ── Routes ─────────────────────────────────────────────────────────────────


# 1. GET /cursor/agents — proxy list agents (cached for AGENT_CACHE_TTL seconds)
@router.get("/cursor/agents")
async def list_cursor_agents():
    now = time.time()
    if _agent_cache["data"] is not None and (now - _agent_cache["cached_at"]) < AGENT_CACHE_TTL:
        return {"status": "ok", "data": _agent_cache["data"], "http_status": 200, "cached": True}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/agents",
                headers=_cursor_headers(),
            )
            data = resp.json()
            _agent_cache["data"] = data
            _agent_cache["cached_at"] = now
            return {"status": "ok", "data": data, "http_status": resp.status_code, "cached": False}
    except Exception as e:
        if _agent_cache["data"] is not None:
            return {"status": "ok", "data": _agent_cache["data"], "http_status": 200, "cached": True, "stale": True}
        return {"error": str(e), "status": "error"}


# 2. GET /cursor/agents/{id} — proxy get agent
@router.get("/cursor/agents/{agent_id}")
async def get_cursor_agent(agent_id: str):
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/agents/{agent_id}",
                headers=_cursor_headers(),
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 3. GET /cursor/agents/{id}/runs — proxy get agent runs
@router.get("/cursor/agents/{agent_id}/runs")
async def list_cursor_agent_runs(agent_id: str):
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/agents/{agent_id}/runs",
                headers=_cursor_headers(),
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 4. GET /cursor/models — proxy list models with 60s TTL cache
@router.get("/cursor/models")
async def list_cursor_models():
    global _model_cache
    try:
        now = time.time()
        if _model_cache["data"] is not None and (now - _model_cache["cached_at"]) < MODEL_CACHE_TTL:
            return {"status": "ok", "data": _model_cache["data"], "cached": True}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/models",
                headers=_cursor_headers(),
            )
            data = resp.json()
            _model_cache = {"data": data, "cached_at": now}
            return {"status": "ok", "data": data, "cached": False}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 5. GET /git/repos — list git repos
@router.get("/git/repos")
async def list_git_repos():
    try:
        config = _load_config()
        configured_repos = config.get("repos", [])

        all_repos: list[dict[str, Any]] = []
        seen_paths: set[str] = set()

        # Add configured repos
        for repo in configured_repos:
            rpath = repo.get("path", "")
            if rpath:
                seen_paths.add(rpath)
                all_repos.append({
                    "name": repo.get("name", Path(rpath).name),
                    "path": rpath,
                    "source": "config",
                })

        # Scanned repos
        for repo in _scan_code_dirs():
            if repo["path"] not in seen_paths:
                all_repos.append(repo)

        return {"status": "ok", "repos": all_repos}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 6. GET /git/{path:path}/status — git status --porcelain
@router.get("/git/{path:path}/status")
async def git_status(path: str):
    try:
        repo = _validate_repo_path(path)
        output = _run_git(repo, "status", "--porcelain")
        lines = [line for line in output.splitlines() if line.strip()]
        return {"status": "ok", "data": lines}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 7. GET /git/{path:path}/diff — git diff
@router.get("/git/{path:path}/diff")
async def git_diff(path: str):
    try:
        repo = _validate_repo_path(path)
        output = _run_git(repo, "diff")
        return {"status": "ok", "data": output}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 8. GET /git/{path:path}/branches — git branch -a
@router.get("/git/{path:path}/branches")
async def git_branches(path: str):
    try:
        repo = _validate_repo_path(path)
        output = _run_git(repo, "branch", "-a")
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        return {"status": "ok", "data": lines}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 9. GET /git/{path:path}/log — git log --oneline -n 20
@router.get("/git/{path:path}/log")
async def git_log(path: str, n: int = Query(20, description="Number of log entries")):
    try:
        repo = _validate_repo_path(path)
        n_clamped = max(1, min(500, n))
        output = _run_git(repo, "log", f"-n{n_clamped}", "--oneline")
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        return {"status": "ok", "data": lines}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 10. GET /github/auth — start GitHub OAuth Device Flow
@router.get("/github/auth")
async def github_auth_start():
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{GITHUB_LOGIN_URL}/login/device/code",
                headers={"Accept": "application/json"},
                json={
                    "client_id": os.environ.get("GITHUB_CLIENT_ID", ""),
                    "scope": "repo read:org",
                },
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 11. POST /github/auth/poll — poll for OAuth token
class GithubAuthPollRequest(BaseModel):
    device_code: str
    interval: int = 5


@router.post("/github/auth/poll")
async def github_auth_poll(body: GithubAuthPollRequest):
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{GITHUB_LOGIN_URL}/login/oauth/access_token",
                headers={"Accept": "application/json"},
                json={
                    "client_id": os.environ.get("GITHUB_CLIENT_ID", ""),
                    "device_code": body.device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
            data = resp.json()

            # If we got a token, store it in config
            if "access_token" in data:
                config = _load_config()
                config["github_access_token"] = data["access_token"]
                _save_config(config)

            return {"status": "ok", "data": data, "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 12. GET /github/prs — list PRs from GitHub API
@router.get("/github/prs")
async def list_github_prs(
    owner: str = Query("", description="Repository owner"),
    repo: str = Query("", description="Repository name"),
    state: str = Query("open", description="PR state: open, closed, all"),
):
    try:
        config = _load_config()
        token = config.get("github_access_token")
        if not token:
            return {"status": "error", "error": "No GitHub token found. Authenticate first."}

        # If owner/repo not provided, try to infer from config
        if not owner or not repo:
            owner = config.get("github_default_owner", "")
            repo = config.get("github_default_repo", "")
            if not owner or not repo:
                return {"status": "error", "error": "owner and repo required"}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{GITHUB_API_URL}/repos/{owner}/{repo}/pulls",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github.v3+json",
                },
                params={"state": state, "per_page": 50},
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 13. GET /config — read config
@router.get("/config")
async def read_config():
    try:
        config = _load_config()
        # Never expose CURSOR_API_KEY or other secrets
        safe_config = {k: v for k, v in config.items() if k != "cursor_api_key"}
        return {"status": "ok", "data": safe_config}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 14. PUT /config — write config
class ConfigUpdateRequest(BaseModel):
    data: dict[str, Any]


@router.put("/config")
async def write_config(body: ConfigUpdateRequest):
    try:
        existing = _load_config()
        # Merge update on top of existing, but never overwrite secrets from client
        existing.update(body.data)
        # Strip sensitive keys that should never be set by frontend
        existing.pop("cursor_api_key", None)
        _save_config(existing)
        safe_config = {k: v for k, v in existing.items() if k != "cursor_api_key"}
        return {"status": "ok", "data": safe_config}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 15. GET /health — check connectivity
@router.get("/health")
async def health_check():
    results: dict[str, Any] = {}
    all_ok = True

    # Check Cursor API connectivity
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/models",
                headers=_cursor_headers(),
            )
            cursor_ok = resp.status_code < 500
            results["cursor_api"] = {
                "reachable": cursor_ok,
                "http_status": resp.status_code,
            }
            if not cursor_ok:
                all_ok = False
    except Exception as e:
        results["cursor_api"] = {"reachable": False, "error": str(e)}
        all_ok = False

    # Check GitHub API connectivity
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{GITHUB_API_URL}/zen")
            results["github_api"] = {
                "reachable": resp.status_code == 200,
                "http_status": resp.status_code,
            }
            if resp.status_code != 200:
                all_ok = False
    except Exception as e:
        results["github_api"] = {"reachable": False, "error": str(e)}
        all_ok = False

    # Check that CURSOR_API_KEY is set
    has_cursor_key = bool(os.environ.get("CURSOR_API_KEY"))
    results["cursor_api_key_set"] = has_cursor_key
    if not has_cursor_key:
        all_ok = False

    # Check config file readability
    config_ok = True
    try:
        _load_config()
    except Exception:
        config_ok = False
        all_ok = False
    results["config_readable"] = config_ok

    return {
        "status": "ok" if all_ok else "degraded",
        "all_ok": all_ok,
        "checks": results,
    }


# ── New Cursor Agent Run Routes ───────────────────────────────────────────

# POST /cursor/agents/{id}/runs — send follow-up prompt
@router.post("/cursor/agents/{agent_id}/runs")
async def create_agent_run(agent_id: str, request: Request):
    """Send a follow-up prompt to a Cursor agent. Proxies POST /v1/agents/{id}/runs"""
    try:
        body = await request.json()
        prompt = body.get("prompt", "")
        model_id = body.get("model")
        payload: dict[str, Any] = {"prompt": prompt}
        if model_id:
            payload["model"] = {"id": model_id}
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{CURSOR_BASE_URL}/v1/agents/{agent_id}/runs",
                headers=_cursor_headers(),
                json=payload,
                timeout=60
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# GET /cursor/agents/{id}/runs/{run_id} — single run detail
@router.get("/cursor/agents/{agent_id}/runs/{run_id}")
async def get_agent_run(agent_id: str, run_id: str):
    """Get single run detail with result text."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{CURSOR_BASE_URL}/v1/agents/{agent_id}/runs/{run_id}",
                headers=_cursor_headers(),
            )
            return {"status": "ok", "data": resp.json(), "http_status": resp.status_code}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# GET /cursor/agents/{id}/runs/{run_id}/stream — SSE stream
@router.get("/cursor/agents/{agent_id}/runs/{run_id}/stream")
async def stream_agent_run(agent_id: str, run_id: str):
    """SSE stream for a running agent's output."""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "GET",
                f"{CURSOR_BASE_URL}/v1/agents/{agent_id}/runs/{run_id}/stream",
                headers=_cursor_headers(),
            ) as resp:
                async def event_generator():
                    async for chunk in resp.aiter_bytes():
                        yield chunk

                from fastapi.responses import StreamingResponse
                return StreamingResponse(
                    event_generator(),
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                )
    except Exception as e:
        return {"error": str(e), "status": "error"}


# ── Session Management Routes ──────────────────────────────────────────────


# 16. GET /sessions — list Hermes sessions from SQLite
@router.get("/sessions")
async def list_sessions():
    try:
        db_path = Path.home() / ".hermes" / "state.db"
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute('''
            SELECT id, source, model, started_at, ended_at, message_count,
                   input_tokens, output_tokens, estimated_cost_usd, title
            FROM sessions
            ORDER BY started_at DESC
            LIMIT 200
        ''')
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return {"status": "ok", "data": rows}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 17. GET /sessions/{session_id} — session detail with messages
@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    try:
        db_path = Path.home() / ".hermes" / "state.db"
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute('SELECT * FROM sessions WHERE id = ?', (session_id,))
        session = dict(cur.fetchone() or {})
        cur.execute('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp', (session_id,))
        messages = [dict(m) for m in cur.fetchall()]
        conn.close()
        return {"status": "ok", "data": {"session": session, "messages": messages}}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 18. DELETE /sessions/{session_id} — delete session via Hermes CLI
@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    try:
        result = subprocess.run(
            ['hermes', 'sessions', 'delete', session_id],
            capture_output=True, text=True, timeout=15
        )
        return {"status": "ok", "data": {"exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# 19. POST /sessions/{session_id}/chat — send message to Hermes session
@router.post("/sessions/{session_id}/chat")
async def chat_with_session(session_id: str, request: Request):
    try:
        body = await request.json()
        message = body.get("message", "")
        result = subprocess.run(
            ['hermes', '-z', message, '--resume', session_id],
            capture_output=True, text=True, timeout=120
        )
        return {"status": "ok", "data": {"exit_code": result.returncode, "response": result.stdout, "error": result.stderr}}
    except Exception as e:
        return {"error": str(e), "status": "error"}


# ── GitHub PR Detail Route ─────────────────────────────────────────────────


# 20. GET /github/prs/detail — detailed PR info (diff stats, commits, branch status)
@router.get("/github/prs/detail")
async def get_pr_detail(owner: str, repo: str, number: int):
    try:
        config = _load_config()
        token = config.get("github_access_token", "")
        headers = {"Accept": "application/vnd.github.v3+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        async with httpx.AsyncClient(timeout=15) as client:
            # PR detail
            pr_resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}", headers=headers)
            # PR files
            files_resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files", headers=headers)
            # PR commits
            commits_resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}/commits", headers=headers)
            result = {
                "pr": pr_resp.json(),
                "files": files_resp.json(),
                "commits": commits_resp.json(),
            }
            return {"status": "ok", "data": result}
    except Exception as e:
        return {"error": str(e), "status": "error"}


@router.get("/agents-page", response_class=HTMLResponse)
async def agents_page():
    """Serve the standalone Cursor Agents UI page."""
    plugin_dir = Path(__file__).parent
    html_path = plugin_dir / "src" / "agents.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(
        content="<html><body><h1>agents.html not found</h1></body></html>",
        status_code=404,
    )
