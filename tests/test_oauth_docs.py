"""Structural tests for the Threads/Meta OAuth documentation (issue #2).

Issue #2 is documentation and configuration only, so these tests guard the
documented shape rather than runtime behaviour:

- ``docs/oauth.md`` documents the end-to-end OAuth flow, minimum scopes,
  callback handling, token exchange, long-lived token lifecycle and refresh,
  and the safe local storage strategy;
- ``.env.example`` exposes ``META_APP_ID`` / ``META_APP_SECRET`` as empty
  placeholders and points at the docs;
- no OAuth tokens, client secrets, or encryption keys are committed.

These are intentionally structural checks on committed Markdown/configuration so
that a regression (a lost section, an accidental secret) is caught by CI.
"""

from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / ".env.example"
OAUTH_DOC = ROOT / "docs" / "oauth.md"
DEPLOY_DOC = ROOT / "docs" / "deploy.md"
GITIGNORE = ROOT / ".gitignore"
DOCKERIGNORE = ROOT / ".dockerignore"


def _env_example_lines() -> list[str]:
    """Return the non-comment, non-blank lines of `.env.example`."""

    lines: list[str] = []
    for line in ENV_EXAMPLE.read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        lines.append(line)
    return lines


# --- docs/oauth.md exists and is complete ---------------------------------


def test_oauth_documentation_exists() -> None:
    assert OAUTH_DOC.exists(), "docs/oauth.md must exist"


@pytest.mark.parametrize(
    "required_heading",
    [
        "The OAuth authorization-code flow",
        "Required minimum scopes",
        "Handle the callback",
        "Exchange the code for a short-lived token",
        "Long-lived token lifecycle",
        "Safe local storage",
        "Secrets kept out of Git",
    ],
)
def test_oauth_doc_covers_each_required_section(required_heading: str) -> None:
    text = OAUTH_DOC.read_text()
    assert required_heading in text, f"docs/oauth.md must document '{required_heading}'"


def test_oauth_doc_documents_the_authorization_url() -> None:
    text = OAUTH_DOC.read_text()
    assert "https://threads.com/oauth/authorize" in text
    assert "client_id" in text
    assert "redirect_uri" in text
    assert "response_type=code" in text
    assert "scope" in text


def test_oauth_doc_documents_minimum_required_scope() -> None:
    text = OAUTH_DOC.read_text()
    # threads_basic is the required minimum scope and cannot be removed.
    assert "threads_basic" in text
    assert "required" in text.lower()


def test_oauth_doc_documents_callback_handling() -> None:
    text = OAUTH_DOC.read_text()
    assert "/admin/oauth/callback/threads" in text
    # The Meta-appended fragment must be stripped and codes are single-use.
    assert "#_" in text
    assert "state" in text


def test_oauth_doc_documents_token_exchange() -> None:
    text = OAUTH_DOC.read_text()
    assert "https://graph.threads.com/oauth/access_token" in text
    assert "grant_type=authorization_code" in text
    assert "client_secret" in text


def test_oauth_doc_documents_long_lived_token_lifecycle() -> None:
    text = OAUTH_DOC.read_text()
    # Exchange a short-lived token for a long-lived one.
    assert "th_exchange_token" in text
    assert "https://graph.threads.com/access_token" in text


def test_oauth_doc_documents_refresh_behavior() -> None:
    text = OAUTH_DOC.read_text()
    assert "th_refresh_token" in text
    assert "https://graph.threads.com/refresh_access_token" in text
    # Refresh rules (24-hour minimum, 60-day expiry) must be stated.
    assert "24" in text and "60" in text


def test_oauth_doc_describes_safe_local_storage() -> None:
    text = OAUTH_DOC.read_text()
    assert "TOKEN_ENCRYPTION_KEY" in text
    assert "encrypted" in text.lower()
    assert "Fernet" in text
    # The key must live outside the database and Git.
    assert "outside" in text.lower()


def test_oauth_doc_links_implementation_tasks() -> None:
    text = OAUTH_DOC.read_text()
    # Issues #15, #16 and #17 own callback, exchange and lifecycle work.
    for issue in ("/issues/15", "/issues/16", "/issues/17"):
        assert issue in text, f"docs/oauth.md must reference {issue}"


# --- .env.example exposes the Meta config empty and links the docs ---------


def _env_value(name: str) -> str | None:
    for line in _env_example_lines():
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1]
    return None


def test_env_example_exposes_meta_app_id_empty() -> None:
    value = _env_value("META_APP_ID")
    assert value is not None, "META_APP_ID must be present in .env.example"
    assert value == "", "META_APP_ID must be an empty placeholder"


def test_env_example_exposes_meta_app_secret_empty() -> None:
    value = _env_value("META_APP_SECRET")
    assert value is not None, "META_APP_SECRET must be present in .env.example"
    assert value == "", "META_APP_SECRET must be an empty placeholder"


def test_env_example_links_to_oauth_docs() -> None:
    text = ENV_EXAMPLE.read_text()
    assert "docs/oauth.md" in text


def test_env_example_does_not_reference_a_real_encryption_key() -> None:
    text = ENV_EXAMPLE.read_text()
    assert "gAAAAA" not in text
    # No uncommented TOKEN_ENCRYPTION_KEY carries a value.
    for line in _env_example_lines():
        if line.startswith("TOKEN_ENCRYPTION_KEY="):
            assert line.split("=", 1)[1] == ""


# --- No secrets, tokens, or keys are committed -----------------------------


def _tracked_text_files() -> list[Path]:
    """Files a secret could plausibly leak into (config, code, docs)."""

    candidates: list[Path] = []
    for pattern in ("*.py", "*.yaml", "*.yml", "*.md", "*.mjs", "*.sh", "Dockerfile*"):
        candidates.extend(ROOT.glob(f"**/{pattern}"))
    # Add the env template at the repo root explicitly (glob hides dotfiles).
    candidates.append(ENV_EXAMPLE)
    # Only files that are actually tracked by Git.
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--", "."],
        capture_output=True,
        text=True,
        check=True,
    )
    tracked = {Path(line) for line in result.stdout.split("\0") if line}
    return [c for c in candidates if c in tracked]


def test_no_committed_value_resembles_a_fernet_key() -> None:
    # Fernet keys are base64 and start with "gAAAAA". They must never appear in
    # tracked files (only ever as a literal string in a negative test guard or
    # a generation command, which these negative assertions tolerate).
    needle = "gAAAAA"
    for path in _tracked_text_files():
        if path.name in {"test_deployment_config.py", "test_oauth_docs.py"}:
            continue
        assert needle not in path.read_text(), (
            f"Possible Fernet key committed in {path}"
        )


def test_no_committed_meta_app_id_carries_a_real_value() -> None:
    import re

    for path in _tracked_text_files():
        for line in path.read_text().splitlines():
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            if re.match(r"^META_APP_ID=\d{5,}", stripped):
                pytest.fail(f"Real-looking META_APP_ID committed in {path}: {line}")


def test_no_untracked_env_or_secrets_file_is_committed() -> None:
    # The repository must only ever track .env.example, never a real .env.
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "--", ".env", "secrets/"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "", "Real .env or secrets/ files must not be tracked"


def test_dotenv_and_secrets_are_gitignored() -> None:
    gitignore = GITIGNORE.read_text()
    assert ".env" in gitignore
    assert "secrets/" in gitignore


def test_dockerignore_excludes_env_and_secrets() -> None:
    dockerignore = DOCKERIGNORE.read_text()
    assert ".env" in dockerignore
    assert "secrets/" in dockerignore


def test_oauth_docs_are_cross_referenced_from_readme() -> None:
    readme = (ROOT / "README.md").read_text()
    assert "docs/oauth.md" in readme


def test_deploy_doc_still_describes_encrypted_persistence() -> None:
    text = DEPLOY_DOC.read_text()
    assert "token_encryption_key" in text
    assert "encrypted" in text.lower()
