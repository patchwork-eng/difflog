const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const OpenAI = require('openai').default;
const fs = require('fs');
const { execSync } = require('child_process');

async function run() {
  try {
    // ── Inputs ──────────────────────────────────────────────────────────────
    const openaiKey = core.getInput('openai_key', { required: true });
    const model = core.getInput('model') || 'gpt-4o-mini';
    const maxCommits = parseInt(core.getInput('max_commits') || '50', 10);

    if (!openaiKey) {
      core.setFailed(
        'No OpenAI API key provided. ' +
        'Public repos: add your key as a repo secret OPENAI_API_KEY and pass it via openai_key input. ' +
        'Private repos: same — your key, your privacy.'
      );
      return;
    }

    // ── GitHub context ───────────────────────────────────────────────────────
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      core.setFailed('GITHUB_TOKEN is not set. Add "permissions: contents: write" to your workflow.');
      return;
    }

    const octokit = new Octokit({ auth: token });
    const { owner, repo } = github.context.repo;
    const sha = github.context.sha;

    core.info(`Running Difflog on ${owner}/${repo} @ ${sha.slice(0, 7)}`);

    // ── Find the latest release tag ──────────────────────────────────────────
    let latestTag = null;
    let nextVersion = 'Unreleased';

    try {
      const { data: releases } = await octokit.repos.listReleases({
        owner,
        repo,
        per_page: 1,
      });

      if (releases.length > 0) {
        latestTag = releases[0].tag_name;
        // Attempt to bump the patch version for the header
        const match = latestTag.match(/^v?(\d+)\.(\d+)\.(\d+)(.*)$/);
        if (match) {
          nextVersion = `v${match[1]}.${match[2]}.${parseInt(match[3], 10) + 1}${match[4]}`;
        } else {
          nextVersion = `${latestTag}-next`;
        }
        core.info(`Last release tag: ${latestTag} → generating changelog for ${nextVersion}`);
      } else {
        core.info('No prior releases found — generating changelog for all commits.');
      }
    } catch (err) {
      core.warning(`Could not fetch releases: ${err.message}. Proceeding with all commits.`);
    }

    // ── Fetch commits since last tag ─────────────────────────────────────────
    let commits = [];

    if (latestTag) {
      try {
        // Compare tag...HEAD
        const { data: comparison } = await octokit.repos.compareCommits({
          owner,
          repo,
          base: latestTag,
          head: sha,
        });
        commits = comparison.commits;
      } catch (err) {
        core.warning(`Could not compare to tag ${latestTag}: ${err.message}. Falling back to recent commits.`);
      }
    }

    // Fallback: grab recent commits from the current branch
    if (commits.length === 0) {
      const { data: recentCommits } = await octokit.repos.listCommits({
        owner,
        repo,
        sha,
        per_page: maxCommits,
      });
      commits = recentCommits;
    }

    // ── Filter and cap ───────────────────────────────────────────────────────
    const BOT_PATTERN = /\[bot\]|dependabot|github-actions/i;
    const MERGE_PATTERN = /^Merge (pull request|branch|remote)/i;

    const filtered = commits
      .filter(c => {
        const msg = c.commit.message.split('\n')[0].trim();
        const author = c.commit.author?.name || '';
        if (MERGE_PATTERN.test(msg)) return false;
        if (BOT_PATTERN.test(author)) return false;
        return true;
      })
      .slice(0, maxCommits);

    if (filtered.length === 0) {
      core.warning('No commits to summarize after filtering. Skipping changelog generation.');
      return;
    }

    core.info(`Summarizing ${filtered.length} commits...`);

    // ── Build the prompt ─────────────────────────────────────────────────────
    const commitList = filtered
      .map(c => {
        const msg = c.commit.message.split('\n')[0].trim(); // subject only
        const author = c.commit.author?.name || 'unknown';
        const abbrev = c.sha.slice(0, 7);
        return `- [${abbrev}] ${msg} (${author})`;
      })
      .join('\n');

    const today = new Date().toISOString().split('T')[0];

    const systemPrompt = `You are a technical writer generating a polished CHANGELOG.md section for a software project.
Your output will be placed directly into a CHANGELOG.md file — no extra commentary, no markdown fences.

Rules:
1. Use "${nextVersion}" as the top-level heading (## ${nextVersion} — ${today}).
2. Group changes into these subsections (only include sections that have entries):
   ### ⚠️ Breaking Changes
   ### ✨ Features
   ### 🐛 Bug Fixes
   ### 🔧 Chores & Maintenance
3. Write in clear prose per entry — not just raw commit messages. Make it readable.
4. Skip anything that is clearly trivial noise (typo in comment, formatting only, version bumps with no context).
5. If commits follow Conventional Commits format (feat:, fix:, chore:, etc.) use that to categorize.
   If they don't, infer the category from the content of the message.
6. Do NOT include merge commits or bot commits (they've been filtered, but ignore if any slipped through).
7. Output only the markdown — no explanation, no preamble.`;

    const userPrompt = `Here are the commits since the last release (${latestTag || 'beginning of repo'}):\n\n${commitList}\n\nGenerate the changelog section.`;

    // ── Call OpenAI ──────────────────────────────────────────────────────────
    const openai = new OpenAI({ apiKey: openaiKey });

    core.info(`Calling OpenAI (${model})...`);

    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    });

    const newSection = response.choices[0].message.content.trim();

    // ── Write CHANGELOG.md ───────────────────────────────────────────────────
    let existingChangelog = '';
    if (fs.existsSync('CHANGELOG.md')) {
      existingChangelog = fs.readFileSync('CHANGELOG.md', 'utf8');
      // Remove any existing entry for the same version to avoid duplication
      const versionHeader = `## ${nextVersion}`;
      const idx = existingChangelog.indexOf(versionHeader);
      if (idx !== -1) {
        // Find next ## header after this one
        const nextIdx = existingChangelog.indexOf('\n## ', idx + 1);
        if (nextIdx !== -1) {
          existingChangelog = existingChangelog.slice(0, idx) + existingChangelog.slice(nextIdx + 1);
        } else {
          existingChangelog = existingChangelog.slice(0, idx);
        }
      }
    }

    const header = existingChangelog.startsWith('# Changelog')
      ? ''
      : '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n';

    const updatedChangelog = header + newSection + '\n\n' + existingChangelog.replace(/^# Changelog\n[^\n]*\n\n/, '');

    fs.writeFileSync('CHANGELOG.md', updatedChangelog);
    core.info('CHANGELOG.md written.');
    core.setOutput('changelog_path', 'CHANGELOG.md');

    // ── Commit CHANGELOG.md back to the repo ─────────────────────────────────
    try {
      execSync('git config user.name "Difflog Bot"');
      execSync('git config user.email "bot@difflog.io"');
      execSync('git add CHANGELOG.md');

      // Only commit if there are staged changes
      const status = execSync('git status --porcelain').toString().trim();
      if (status) {
        execSync(`git commit -m "chore: update CHANGELOG.md for ${nextVersion} [skip ci]"`);
        execSync('git push');
        core.info('CHANGELOG.md committed and pushed.');
      } else {
        core.info('No changes to CHANGELOG.md — nothing to commit.');
      }
    } catch (gitErr) {
      core.warning(`Could not commit CHANGELOG.md: ${gitErr.message}`);
      core.warning('Ensure the workflow has "permissions: contents: write".');
    }

    core.info('✅ Difflog complete.');
  } catch (err) {
    core.setFailed(`Difflog failed: ${err.message}`);
  }
}

run();
