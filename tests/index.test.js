/**
 * Difflog — Unit Tests
 * Run with: npm test
 */

// Mock @actions/core before requiring the module under test
jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
  setOutput: jest.fn(),
}));

// Mock @actions/github
jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    sha: 'abc1234567890abcdef',
  },
}));

// Mock @octokit/rest — expose internals via __mockRepos for test access
jest.mock('@octokit/rest', () => {
  const repos = {
    get: jest.fn(),
    listReleases: jest.fn(),
    compareCommits: jest.fn(),
    listCommits: jest.fn(),
  };
  return {
    Octokit: jest.fn(() => ({ repos })),
    __mockRepos: repos,
  };
});

// Mock openai — expose create fn via __mockCreate
jest.mock('openai', () => {
  const create = jest.fn();
  return {
    default: jest.fn(() => ({ chat: { completions: { create } } })),
    __mockCreate: create,
  };
});

// Mock fs (selective — keep real fs for everything except our target methods)
jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    copyFileSync: jest.fn(),
    unlinkSync: jest.fn(),
  };
});

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const core = require('@actions/core');
const fs = require('fs');
const { execSync } = require('child_process');
const { __mockRepos: mockRepos } = require('@octokit/rest');
const { __mockCreate: mockOpenAICreate } = require('openai');

const {
  filterCommits,
  bumpVersion,
  buildPrompt,
  prependChangelog,
  callOpenAIWithRetry,
  run,
} = require('../src/index');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCommit(message, author = 'Alice', sha = 'abc1234def56789') {
  return {
    sha,
    commit: {
      message,
      author: { name: author },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GITHUB_TOKEN = 'test-token';
});

// ─── filterCommits ────────────────────────────────────────────────────────────

describe('filterCommits', () => {
  test('keeps normal commits', () => {
    const commits = [makeCommit('feat: add login page', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('filters out merge commits — pull request', () => {
    const commits = [
      makeCommit('Merge pull request #1 from feature/auth', 'Alice'),
      makeCommit('fix: real commit', 'Dave'),
    ];
    const result = filterCommits(commits);
    expect(result).toHaveLength(1);
    expect(result[0].commit.message).toBe('fix: real commit');
  });

  test('filters out merge commits — branch', () => {
    const commits = [
      makeCommit('Merge branch main into dev', 'Bob'),
      makeCommit('fix: real commit', 'Dave'),
    ];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('filters out merge commits — remote-tracking', () => {
    const commits = [
      makeCommit('Merge remote-tracking branch origin/main', 'Carol'),
      makeCommit('chore: cleanup', 'Dave'),
    ];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('filters out dependabot commits', () => {
    const commits = [
      makeCommit('chore: bump deps', 'dependabot'),
      makeCommit('fix: human change', 'Alice'),
    ];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('filters out github-actions[bot] commits', () => {
    const commits = [
      makeCommit('build: update action', 'github-actions[bot]'),
      makeCommit('feat: real feature', 'Alice'),
    ];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('filters out empty commit messages', () => {
    const commits = [
      makeCommit('', 'Alice'),
      makeCommit('   ', 'Bob'),
      makeCommit('fix: valid commit', 'Carol'),
    ];
    const result = filterCommits(commits);
    expect(result).toHaveLength(1);
    expect(result[0].commit.message).toBe('fix: valid commit');
  });

  test('uses only first line of multi-line commit messages', () => {
    const commits = [makeCommit('feat: add feature\n\nLonger description here.\nMore details.', 'Alice')];
    const result = filterCommits(commits);
    expect(result).toHaveLength(1);
  });

  test('passes through non-ASCII characters', () => {
    const commits = [
      makeCommit('fix: 修复登录问题', 'Alice'),
      makeCommit('feat: añadir autenticación', 'Bob'),
    ];
    expect(filterCommits(commits)).toHaveLength(2);
  });

  test('passes through emoji in commit messages', () => {
    const commits = [
      makeCommit('fix: squash the 🐛 bug', 'Alice'),
      makeCommit('feat: 🚀 launch new feature', 'Bob'),
    ];
    expect(filterCommits(commits)).toHaveLength(2);
  });

  test('respects maxCommits cap (below hard limit)', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit(`fix: commit ${i}`, 'Alice')
    );
    expect(filterCommits(commits, 5)).toHaveLength(5);
  });

  test('warns and truncates at 200 hard limit', () => {
    const commits = Array.from({ length: 250 }, (_, i) =>
      makeCommit(`fix: commit ${i}`, 'Alice')
    );
    const result = filterCommits(commits, 50);
    expect(result).toHaveLength(200);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Truncating to most recent 200')
    );
  });

  test('does not warn when under hard limit', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit(`fix: commit ${i}`, 'Alice')
    );
    filterCommits(commits, 50);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test('returns empty array when all commits are filtered', () => {
    const commits = [
      makeCommit('Merge pull request #1', 'Alice'),
      makeCommit('', 'Bob'),
      makeCommit('chore: bump deps', 'dependabot'),
    ];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('handles commits with undefined author gracefully', () => {
    const commit = {
      sha: 'abc1234',
      commit: { message: 'feat: something', author: undefined },
    };
    expect(() => filterCommits([commit])).not.toThrow();
    expect(filterCommits([commit])).toHaveLength(1);
  });
});

// ─── bumpVersion ─────────────────────────────────────────────────────────────

describe('bumpVersion', () => {
  test('returns Unreleased when tag is null', () => {
    expect(bumpVersion(null)).toBe('Unreleased');
  });

  test('returns Unreleased when tag is undefined', () => {
    expect(bumpVersion(undefined)).toBe('Unreleased');
  });

  test('returns Unreleased when tag is empty string', () => {
    expect(bumpVersion('')).toBe('Unreleased');
  });

  test('bumps patch version — v1.2.3 → v1.2.4', () => {
    expect(bumpVersion('v1.2.3')).toBe('v1.2.4');
  });

  test('bumps patch version — without v prefix', () => {
    expect(bumpVersion('1.0.0')).toBe('v1.0.1');
  });

  test('handles large patch numbers', () => {
    expect(bumpVersion('v0.9.99')).toBe('v0.9.100');
  });

  test('preserves pre-release suffix', () => {
    expect(bumpVersion('v1.2.3-beta')).toBe('v1.2.4-beta');
  });

  test('appends -next for non-semver tags', () => {
    expect(bumpVersion('release-2024')).toBe('release-2024-next');
  });

  test('appends -next for arbitrary string tags', () => {
    expect(bumpVersion('stable')).toBe('stable-next');
  });
});

// ─── buildPrompt ─────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const commits = [
    makeCommit('feat: add dark mode', 'Alice', 'aabbccdd1234567'),
    makeCommit('fix: crash on logout', 'Bob', 'eeff00112233445'),
  ];

  test('includes version heading in system prompt', () => {
    const { systemPrompt } = buildPrompt(commits, 'v1.0.0', 'v1.0.1', '2024-01-15');
    expect(systemPrompt).toContain('v1.0.1');
    expect(systemPrompt).toContain('2024-01-15');
  });

  test('includes commit messages in user prompt', () => {
    const { userPrompt } = buildPrompt(commits, 'v1.0.0', 'v1.0.1', '2024-01-15');
    expect(userPrompt).toContain('feat: add dark mode');
    expect(userPrompt).toContain('fix: crash on logout');
  });

  test('includes abbreviated SHA in user prompt', () => {
    const { userPrompt } = buildPrompt(commits, 'v1.0.0', 'v1.0.1', '2024-01-15');
    expect(userPrompt).toContain('aabbccd'); // first 7 chars
  });

  test('mentions latestTag in user prompt', () => {
    const { userPrompt } = buildPrompt(commits, 'v1.0.0', 'v1.0.1', '2024-01-15');
    expect(userPrompt).toContain('v1.0.0');
  });

  test('handles no previous tag gracefully', () => {
    const { userPrompt } = buildPrompt(commits, null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('beginning of repo');
  });

  test('passes non-ASCII characters through intact', () => {
    const unicodeCommits = [makeCommit('fix: 修复登录问题', 'Alice', 'aabbccdd1234567')];
    const { userPrompt } = buildPrompt(unicodeCommits, null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('修复登录问题');
  });

  test('passes emoji through intact', () => {
    const emojiCommits = [makeCommit('fix: squash the 🐛 bug', 'Alice', 'aabbccdd1234567')];
    const { userPrompt } = buildPrompt(emojiCommits, null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('🐛');
  });
});

// ─── prependChangelog ─────────────────────────────────────────────────────────

describe('prependChangelog', () => {
  const newSection = '## v1.2.4 — 2024-01-15\n\n### ✨ Features\n- Added dark mode';

  test('creates fresh changelog when content is empty', () => {
    const result = prependChangelog('', newSection, 'v1.2.4');
    expect(result).toContain('# Changelog');
    expect(result).toContain(newSection);
  });

  test('always includes # Changelog header', () => {
    const result = prependChangelog('', newSection, 'v1.2.4');
    expect(result.startsWith('# Changelog')).toBe(true);
  });

  test('preserves # Changelog header when file already had one', () => {
    const existing =
      '# Changelog\n\nAll notable changes...\n\n## v1.2.3 — 2024-01-01\n\n- Old stuff';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect(result.startsWith('# Changelog')).toBe(true);
    // Should only appear once
    expect((result.match(/^# Changelog/gm) || []).length).toBe(1);
  });

  test('new section appears before old sections', () => {
    const existing =
      '# Changelog\n\nAll notable changes...\n\n## v1.2.3 — 2024-01-01\n\n- Old stuff';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect(result.indexOf('v1.2.4')).toBeLessThan(result.indexOf('v1.2.3'));
  });

  test('deduplicates existing entry for same version', () => {
    const oldSection = '## v1.2.4 — 2024-01-14\n\n### ✨ Features\n- Old entry (stale)';
    const existing = `# Changelog\n\nAll notable changes...\n\n${oldSection}\n\n## v1.2.3\n\n- Older`;
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    const count = (result.match(/## v1\.2\.4/g) || []).length;
    expect(count).toBe(1);
    expect(result).toContain('Added dark mode');      // new section present
    expect(result).not.toContain('Old entry (stale)'); // old section removed
    expect(result).toContain('## v1.2.3');             // older entries kept
  });

  test('adds header when existing file has none', () => {
    const existing = '## v1.2.3 — 2024-01-01\n\n- Old stuff without header';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect(result).toContain('# Changelog');
  });
});

// ─── callOpenAIWithRetry ──────────────────────────────────────────────────────

describe('callOpenAIWithRetry', () => {
  test('returns trimmed content on first successful call', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '  ## v1.0.0\n\n- Feature  ' } }],
    });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };

    const result = await callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0);
    expect(result).toBe('## v1.0.0\n\n- Feature');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('retries once on failure and succeeds on second attempt', async () => {
    const mockCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: '## v1.0.0' } }],
      });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };

    const result = await callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0);
    expect(result).toBe('## v1.0.0');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });

  test('throws descriptive error after all retries exhausted', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('service unavailable'));
    const mockOpenai = { chat: { completions: { create: mockCreate } } };

    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow('OpenAI API unavailable after 2 attempt(s)');
    expect(mockCreate).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry
  });

  test('with maxRetries=0 tries exactly once then throws', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('bad api key'));
    const mockOpenai = { chat: { completions: { create: mockCreate } } };

    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 0, 0)
    ).rejects.toThrow('OpenAI API unavailable after 1 attempt(s)');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('logs warning for each failed attempt', async () => {
    const mockCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'));
    const mockOpenai = { chat: { completions: { create: mockCreate } } };

    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow();

    expect(core.warning).toHaveBeenCalledTimes(2);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('attempt 1'));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('attempt 2'));
  });
});

// ─── run() — Integration tests ────────────────────────────────────────────────

describe('run()', () => {
  // Shared commit list returned by the API
  const fakeCommits = [
    makeCommit('feat: shiny new thing', 'Alice', 'aabbccddeeff001'),
    makeCommit('fix: stop crashing on null', 'Bob', '1122334455667788'),
  ];

  // Default happy-path input mock
  function setupInputs({ licenseKey = '' } = {}) {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return licenseKey;
      return '';
    });
  }

  // Default: public repo
  function setupPublicRepo() {
    mockRepos.get.mockResolvedValue({ data: { private: false } });
  }

  // Default: private repo
  function setupPrivateRepo() {
    mockRepos.get.mockResolvedValue({ data: { private: true } });
  }

  // Default: no prior releases, use listCommits fallback
  function setupNoReleases() {
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({ data: fakeCommits });
  }

  // Default: OpenAI returns content
  function setupOpenAISuccess() {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased — 2024-01-15\n\n### ✨ Features\n- Shiny new thing' } }],
    });
  }

  // Default: git succeeds silently (status shows changes so commit runs)
  function setupGitSuccess() {
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
  }

  // Default: CHANGELOG.md doesn't exist yet
  function setupNoChangelog() {
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
  }

  test('happy path: public repo, valid inputs, OpenAI returns content → changelog written and committed', async () => {
    setupInputs();
    setupPublicRepo();
    setupNoReleases();
    setupOpenAISuccess();
    setupNoChangelog();
    setupGitSuccess();

    await run();

    // Should NOT have called setFailed
    expect(core.setFailed).not.toHaveBeenCalled();

    // Should have written the changelog
    expect(fs.writeFileSync).toHaveBeenCalledWith('CHANGELOG.md', expect.stringContaining('# Changelog'));

    // Should have pushed
    expect(execSync).toHaveBeenCalledWith('git push');

    // Final success log
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });

  test('private repo, no license key → setFailed called with license message', async () => {
    setupInputs({ licenseKey: '' }); // no license key
    setupPrivateRepo();

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'Difflog requires a license key for private repositories. Get one at https://difflog.io'
    );

    // Should not have touched OpenAI or git
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  test('private repo, with license key → validates license and continues', async () => {
    setupInputs({ licenseKey: 'dlk_test_123' });
    setupPrivateRepo();
    setupNoReleases();
    setupOpenAISuccess();
    setupNoChangelog();
    setupGitSuccess();

    // Mock global fetch to simulate a successful license validation response
    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, plan: 'indie' }),
    });

    await run();

    global.fetch = origFetch;

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('License valid. Plan: indie');
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });

  test('OpenAI failure after retry → setFailed called with status.openai.com link', async () => {
    setupInputs();
    setupPublicRepo();
    setupNoReleases();

    // OpenAI always fails
    mockOpenAICreate.mockRejectedValue(new Error('503 Service Unavailable'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('https://status.openai.com')
    );

    // Changelog should NOT have been written
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('git push failure → setFailed called with permissions guidance', async () => {
    setupInputs();
    setupPublicRepo();
    setupNoReleases();
    setupOpenAISuccess();
    setupNoChangelog();

    // Simulate push failing
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      if (cmd === 'git push') throw new Error('remote: Permission denied');
      return Buffer.from('');
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('permissions: contents: write')
    );
  });

  test('CHANGELOG.md write failure → backup restored, warning issued (not hard fail)', async () => {
    setupInputs();
    setupPublicRepo();
    setupNoReleases();
    setupOpenAISuccess();

    // File exists
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('# Changelog\n\n## v0.9.0\n\n- Old stuff');
    fs.copyFileSync.mockImplementation(() => {}); // backup succeeds
    fs.writeFileSync.mockImplementation(() => { throw new Error('EROFS: read-only file system'); });
    fs.unlinkSync.mockImplementation(() => {});

    await run();

    // Should warn, not fail hard
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write CHANGELOG.md')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
