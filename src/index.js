const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const OpenAI = require('openai').default;
const fs = require('fs');
const { execSync } = require('child_process');

const HARD_COMMIT_LIMIT = 200;

// ── Pure / testable functions ────────────────────────────────────────────────

/**
 * Filter out merge commits, bot commits, and empty messages.
 * Applies a hard cap of HARD_COMMIT_LIMIT (200), then maxCommits.
 */
function filterCommits(commits, maxCommits = 50) {
  const BOT_PATTERN = /\[bot\]|dependabot|github-actions/i;
  const MERGE_PATTERN = /^Merge (pull request|branch|remote)/i;

  let filtered = commits.filter(c => {
    const msg = c.commit?.message?.split('\n')[0]?.trim() || '';
    const author = c.commit?.author?.name || '';
    if (!msg) return false; // skip empty / malformed commit messages
    if (MERGE_PATTERN.test(msg)) return false;
    if (BOT_PATTERN.test(author)) return false;
    return true;
  });

  if (filtered.length > HARD_COMMIT_LIMIT) {
    core.warning(
      `${filtered.length} commits found after filtering. ` +
      `Truncating to most recent ${HARD_COMMIT_LIMIT} to stay within token limits.`
    );
    filtered = filtered.slice(0, HARD_COMMIT_LIMIT);
  } else {
    filtered = filtered.slice(0, maxCommits);
  }

  return filtered;
}

/**
 * Bump the patch version of a semver tag. Returns 'Unreleased' if no tag.
 * Non-semver tags get a '-next' suffix.
 */
function bumpVersion(latestTag) {
  if (!latestTag) return 'Unreleased';
  const match = latestTag.match(/^v?(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (match) {
    return `v${match[1]}.${match[2]}.${parseInt(match[3], 10) + 1}${match[4]}`;
  }
  return `${latestTag}-next`;
}

/**
 * Build the system and user prompts for the OpenAI call.
 */
function buildPrompt(filtered, latestTag, nextVersion, today) {
  const commitList = filtered
    .map(c => {
      const msg = c.commit?.message?.split('\n')[0]?.trim() || '(no message)';
      const author = c.commit?.author?.name || 'unknown';
      const abbrev = (c.sha || '0000000').slice(0, 7);
      return `- [${abbrev}] ${msg} (${author})`;
    })
    .join('\n');

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

  return { systemPrompt, userPrompt };
}

/**
 * Prepend a new changelog section into existing CHANGELOG.md content.
 * Always outputs a clean `# Changelog` header.
 * Deduplicates entries for the same version.
 */
function prependChangelog(existingContent, newSection, nextVersion) {
  let existing = existingContent;

  // Remove any existing entry for the same version to avoid duplication
  const versionHeader = `## ${nextVersion}`;
  const versionIdx = existing.indexOf(versionHeader);
  if (versionIdx !== -1) {
    const nextSectionIdx = existing.indexOf('\n## ', versionIdx + 1);
    if (nextSectionIdx !== -1) {
      existing = existing.slice(0, versionIdx) + existing.slice(nextSectionIdx + 1);
    } else {
      existing = existing.slice(0, versionIdx);
    }
  }

  // Extract just the ## version sections, stripping any # Changelog header block
  let olderSections = existing;
  if (existing.trimStart().startsWith('# Changelog')) {
    const firstSection = existing.indexOf('\n## ');
    olderSections = firstSection !== -1 ? existing.slice(firstSection + 1).trimStart() : '';
  } else {
    olderSections = existing.trimStart();
  }

  const HEADER = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n';

  return olderSections
    ? `${HEADER}${newSection}\n\n${olderSections}`
    : `${HEADER}${newSection}\n`;
}

/**
 * Call OpenAI with 1 retry and exponential backoff.
 * Throws a descriptive error if all attempts fail.
 * @param {number} delayMs - Base backoff delay in ms (use 0 in tests)
 */
async function callOpenAIWithRetry(openai, model, systemPrompt, userPrompt, maxRetries = 1, delayMs = 2000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      core.info(`Retrying OpenAI call (attempt ${attempt + 1} of ${maxRetries + 1})...`);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      });
      return response.choices[0].message.content.trim();
    } catch (err) {
      lastErr = err;
      core.warning(`OpenAI API error (attempt ${attempt + 1}): ${err.message}`);
    }
  }
  throw new Error(`OpenAI API unavailable after ${maxRetries + 1} attempt(s): ${lastErr.message}`);
}

// ── Main orchestrator ────────────────────────────────────────────────────────

async function run() {
  try {
    // ── Inputs ──────────────────────────────────────────────────────────────
    const openaiKey = core.getInput('openai_key', { required: true });
    const model = core.getInput('model') || 'gpt-4o-mini';
    const maxCommits = parseInt(core.getInput('max_commits') || '50', 10);

    if (!openaiKey) {
      core.setFailed(
        'No OpenAI API key provided. ' +
        'Add your key as a repo secret OPENAI_API_KEY and pass it via openai_key input.'
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
        nextVersion = bumpVersion(latestTag);
        core.info(`Last release tag: ${latestTag} → generating changelog for ${nextVersion}`);
      } else {
        core.info('No prior releases found — generating changelog for all commits.');
      }
    } catch (err) {
      core.warning(`Could not fetch releases: ${err.message}. Proceeding with all commits.`);
    }

    // ── Fetch commits since last tag ─────────────────────────────────────────
    let rawCommits = [];

    if (latestTag) {
      try {
        const { data: comparison } = await octokit.repos.compareCommits({
          owner,
          repo,
          base: latestTag,
          head: sha,
        });
        rawCommits = comparison.commits;
      } catch (err) {
        core.warning(`Could not compare to tag ${latestTag}: ${err.message}. Falling back to recent commits.`);
      }
    }

    // Fallback: grab recent commits from the current branch
    if (rawCommits.length === 0) {
      const { data: recentCommits } = await octokit.repos.listCommits({
        owner,
        repo,
        sha,
        per_page: maxCommits,
      });
      rawCommits = recentCommits;
    }

    // ── Filter and cap ───────────────────────────────────────────────────────
    const filtered = filterCommits(rawCommits, maxCommits);

    if (filtered.length === 0) {
      core.warning('No commits to summarize after filtering. Skipping changelog generation.');
      return;
    }

    core.info(`Summarizing ${filtered.length} commits...`);

    // ── Build the prompt ─────────────────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    const { systemPrompt, userPrompt } = buildPrompt(filtered, latestTag, nextVersion, today);

    // ── Call OpenAI (with retry) ─────────────────────────────────────────────
    const openai = new OpenAI({ apiKey: openaiKey });
    core.info(`Calling OpenAI (${model})...`);

    let newSection;
    try {
      newSection = await callOpenAIWithRetry(openai, model, systemPrompt, userPrompt);
    } catch (openaiErr) {
      core.setFailed(
        `OpenAI is unavailable: ${openaiErr.message}\n` +
        'Check your OPENAI_API_KEY secret and OpenAI service status at https://status.openai.com'
      );
      return;
    }

    // ── Write CHANGELOG.md ───────────────────────────────────────────────────
    let existingContent = '';
    if (fs.existsSync('CHANGELOG.md')) {
      existingContent = fs.readFileSync('CHANGELOG.md', 'utf8');
    } else {
      core.info('CHANGELOG.md not found — creating it fresh.');
    }

    const updatedChangelog = prependChangelog(existingContent, newSection, nextVersion);
    fs.writeFileSync('CHANGELOG.md', updatedChangelog);
    core.info('CHANGELOG.md written.');
    core.setOutput('changelog_path', 'CHANGELOG.md');

    // ── Commit CHANGELOG.md back to the repo ─────────────────────────────────
    try {
      execSync('git config user.name "Difflog Bot"');
      execSync('git config user.email "bot@difflog.io"');
      execSync('git add CHANGELOG.md');

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

// ── Exports (for testing) ────────────────────────────────────────────────────
module.exports = { filterCommits, bumpVersion, buildPrompt, prependChangelog, callOpenAIWithRetry };

// ── Entry point ──────────────────────────────────────────────────────────────
if (require.main === module) {
  run();
}
