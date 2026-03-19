# Difflog

**Difflog automatically generates a human-readable CHANGELOG.md from your git commits — drop it in your workflow and never write a changelog by hand again.**

---

## Quick Start

```yaml
name: Difflog
on:
  push:
    branches: [main]

permissions:
  contents: write   # ← required to commit CHANGELOG.md

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: patchwork-eng/difflog@v1
        with:
          openai_key: ${{ secrets.OPENAI_API_KEY }}
          # license_key: ${{ secrets.DIFFLOG_LICENSE_KEY }}  # Required for private repos
```

> **⚠️ Required:** `contents: write` permission must be set so Difflog can commit `CHANGELOG.md` back to your repo.

---

## How It Works

On every push to main, Difflog:

1. Finds your last release tag
2. Fetches all commits since that tag
3. Filters out bots, merges, and noise
4. Sends the commit list to OpenAI
5. Writes a grouped, human-readable section to `CHANGELOG.md`
6. Commits and pushes `CHANGELOG.md` back with `[skip ci]`

The generated changelog is grouped into:
- **✨ Features** — new capabilities
- **🐛 Bug Fixes** — things that were broken
- **🔧 Chores & Maintenance** — dependency bumps, refactors, CI changes
- **⚠️ Breaking Changes** — anything that requires user action

---

## Example Output

```markdown
## v1.3.0 — 2026-03-19

### ✨ Features
- Added dark mode toggle to the dashboard settings panel
- Introduced rate limiting on the /api/upload endpoint to prevent abuse

### 🐛 Bug Fixes
- Fixed a crash when uploading files larger than 10MB caused by missing buffer bounds check
- Resolved session token expiry not being respected on mobile clients

### 🔧 Chores & Maintenance
- Bumped Node.js runtime to v22
- Improved error messages across the API for clearer debugging
```

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `openai_key` | ✅ | — | Your OpenAI API key |
| `license_key` | For private repos | `''` | Difflog license key |
| `model` | No | `gpt-4o-mini` | OpenAI model to use |
| `max_commits` | No | `50` | Max commits to analyze per run |

---

## Pricing

| Plan | Price | For |
|---|---|---|
| **Free** | $0 | Public repos, unlimited |
| **Indie** | $9/mo | Private repos, 1 user |
| **Teams** | $29/mo | Private repos, unlimited team members |

Get a license key at **[difflog.io](https://difflog.io)**.

---

## Trust & Security (BYOK)

Difflog uses **Bring Your Own Key (BYOK)**. Your OpenAI API key is passed directly from your GitHub Secrets to the OpenAI API — it never touches our servers.

What we do see:
- License validation requests (repo name + license key) for private repos
- Nothing else

Your commits go directly from GitHub to OpenAI using your own key.

---

## Sister Product

Need PR descriptions too? Check out **[AutoPR](https://autopr.dev)** — the same team, same philosophy. Drop it in your workflow and get auto-generated PR descriptions every time you open a pull request.

---

## License

MIT
