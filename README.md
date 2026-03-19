# difflog

> **Generate a human-readable CHANGELOG.md from your git commits G�� powered by AI.**
>
> No templates. No config. Just plug it in and ship.

difflog is a GitHub Action that reads your git commit history and uses OpenAI to write a clean, developer-friendly changelog in plain English.

---

## Usage

Add this step to any workflow after checking out your repo:

```yaml
- name: Generate changelog
  uses: patchwork-eng/difflog@v1
  with:
    openai_key: ${{ secrets.OPENAI_API_KEY }}
```

That's it. difflog will:
1. Read your recent commits since the last tag
2. Ask GPT to summarize them into a human-readable `CHANGELOG.md`
3. Commit and push `CHANGELOG.md` back to your repo

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `openai_key` | Yes | — | Your OpenAI API key (store as a secret) |
| `model` | No | `gpt-4o-mini` | OpenAI model to use |
| `max_commits` | No | `50` | Max commits to analyze |

---

## Setup

1. Add your OpenAI API key as a repo secret named `OPENAI_API_KEY`
2. Add the action to your workflow (see Usage above)
3. Push to `main` G�� your `CHANGELOG.md` will be auto-generated

---

## Example output

```markdown
## v1.2.0

- Added dark mode toggle to the dashboard
- Fixed crash when uploading files larger than 10MB
- Improved error messages across the API
- Bumped Node.js to v22
```

---

## License

MIT

<!-- audit: March 18 -->
