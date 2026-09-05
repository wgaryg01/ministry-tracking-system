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


def list_github_issues(page: int = 1, per_page: int = 10) -> list[dict]:
    """
    Lists issues on the configured repo, open and closed, most recent
    first — so anyone can check status without a GitHub account, same
    as reporting one. Paginated via GitHub's own page/per_page params
    rather than fetching everything and slicing here.
    """
    if not settings.github_configured:
        raise GitHubIssueError("GitHub issue reporting isn't configured (GITHUB_TOKEN/GITHUB_REPO)")

    url = (
        f"https://api.github.com/repos/{settings.github_repo}/issues"
        f"?state=all&sort=created&direction=desc&page={page}&per_page={per_page}"
    )
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise GitHubIssueError(f"GitHub API returned {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise GitHubIssueError(f"Could not reach GitHub: {e.reason}")

    # GitHub's issues list also includes pull requests — filter those
    # out, but base has_more on the raw page size (before filtering)
    # since that's what actually tells us whether GitHub had more to give.
    has_more = len(data) == per_page
    issues = [item for item in data if "pull_request" not in item]
    return issues, has_more
