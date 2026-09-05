import json
import urllib.request
import urllib.error

from app.config import settings


class GitHubIssueError(Exception):
    pass


def create_github_issue(title: str, body: str, labels: list[str] | None = None) -> dict:
    """
    Creates an issue on the configured repo via GitHub's REST API,
    using a plain server-side token — no GitHub account needed by
    whoever triggers this (a user clicking "Report an issue," or an
    unhandled exception). No-ops with a clear error if not configured,
    rather than silently doing nothing.
    """
    if not settings.github_configured:
        raise GitHubIssueError("GitHub issue reporting isn't configured (GITHUB_TOKEN/GITHUB_REPO)")

    url = f"https://api.github.com/repos/{settings.github_repo}/issues"
    payload = {"title": title[:250], "body": body}
    if labels:
        payload["labels"] = labels

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise GitHubIssueError(f"GitHub API returned {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise GitHubIssueError(f"Could not reach GitHub: {e.reason}")
