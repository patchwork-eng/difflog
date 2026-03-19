/**
 * Difflog — Extended Unit Tests (Whitebox + Blackbox corner cases)
 * Run with: npm test
 */

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
  setOutput: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    repo: { owner: 'test-owner', repo: 'test-repo' },
    sha: 'abc1234567890abcdef',
  },
}));

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

jest.mock('openai', () => {
  const create = jest.fn();
  return {
    default: jest.fn(() => ({ chat: { completions: { create } } })),
    __mockCreate: create,
  };
});

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

// ─── filterCommits — additional corner cases ──────────────────────────────────

describe('filterCommits — commit message edge cases', () => {
  test('only whitespace message is filtered out', () => {
    const commits = [makeCommit('   \t\n   ', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('only emoji message passes through (not a merge/bot)', () => {
    const commits = [makeCommit('🎉🚀✨', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('10,000 char message passes through', () => {
    const longMsg = 'feat: ' + 'a'.repeat(9994);
    expect(longMsg.length).toBe(10000);
    const commits = [makeCommit(longMsg, 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('RTL text in commit message passes through', () => {
    const commits = [makeCommit('fix: إصلاح خطأ في تسجيل الدخول', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('code blocks in commit message pass through', () => {
    const commits = [makeCommit('fix: update `foo()` to handle null', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('multiline commit — only first line checked for merge pattern', () => {
    const commits = [
      makeCommit('feat: add auth\n\nMerge pull request #99 from feature/x', 'Alice'),
    ];
    // First line is "feat: add auth" which doesn't match merge pattern
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('merge pattern on second line only — not filtered', () => {
    const commits = [
      makeCommit('chore: cleanup\nMerge branch main', 'Alice'),
    ];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('null bytes in commit message — passes through (treated as non-empty)', () => {
    const commits = [makeCommit('fix: patch \x00 issue', 'Alice')];
    expect(filterCommits(commits)).toHaveLength(1);
  });
});

describe('filterCommits — author edge cases', () => {
  test('filters [bot] suffix — exact lowercase', () => {
    const commits = [makeCommit('chore: update', 'some-tool[bot]')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('filters dependabot[bot]', () => {
    const commits = [makeCommit('chore: bump lodash', 'dependabot[bot]')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('filters renovate[bot] — matches [bot] pattern', () => {
    // renovate[bot] matches the \[bot\] part of BOT_PATTERN
    const commits = [makeCommit('chore: update deps', 'renovate[bot]')];
    // The [bot] suffix is matched by the regex, so it IS filtered
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('filters github-actions email style author', () => {
    const commits = [makeCommit('ci: build', 'github-actions')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('case-insensitive filter for dependabot — DEPENDABOT', () => {
    const commits = [makeCommit('chore: bump', 'DEPENDABOT')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('case-insensitive filter for GITHUB-ACTIONS', () => {
    const commits = [makeCommit('ci: stuff', 'GITHUB-ACTIONS')];
    expect(filterCommits(commits)).toHaveLength(0);
  });

  test('all-caps human author passes through', () => {
    const commits = [makeCommit('feat: thing', 'ALICE SMITH')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('author with special chars passes through', () => {
    const commits = [makeCommit('fix: bug', 'O\'Brien, Connor')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('author with unicode name passes through', () => {
    const commits = [makeCommit('fix: crash', 'Ångström Björk')];
    expect(filterCommits(commits)).toHaveLength(1);
  });

  test('empty string author — not a bot, passes through', () => {
    const commit = {
      sha: 'abc1234',
      commit: { message: 'feat: something', author: { name: '' } },
    };
    expect(filterCommits([commit])).toHaveLength(1);
  });
});

describe('filterCommits — commit count edge cases', () => {
  test('0 commits returns empty array', () => {
    expect(filterCommits([])).toHaveLength(0);
  });

  test('1 commit returns that commit', () => {
    const commits = [makeCommit('feat: one thing', 'Alice')];
    expect(filterCommits(commits, 50)).toHaveLength(1);
  });

  test('exactly 200 commits — no warning, returns 200', () => {
    const commits = Array.from({ length: 200 }, (_, i) =>
      makeCommit(`feat: commit ${i}`, 'Alice')
    );
    const result = filterCommits(commits, 50);
    // After filtering (200 > maxCommits=50), uses maxCommits path... wait no.
    // 200 > HARD_COMMIT_LIMIT(200) is false, so it uses slice(0, maxCommits)
    expect(result).toHaveLength(50);
    expect(core.warning).not.toHaveBeenCalled();
  });

  test('exactly 201 commits after filtering — warning issued, truncated to 200', () => {
    const commits = Array.from({ length: 201 }, (_, i) =>
      makeCommit(`feat: commit ${i}`, 'Alice')
    );
    const result = filterCommits(commits, 50);
    expect(result).toHaveLength(200);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Truncating to most recent 200')
    );
  });

  test('500 commits — warning issued, truncated to 200', () => {
    const commits = Array.from({ length: 500 }, (_, i) =>
      makeCommit(`fix: commit ${i}`, 'Alice')
    );
    const result = filterCommits(commits, 50);
    expect(result).toHaveLength(200);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('500 commits found')
    );
  });

  test('maxCommits of 1 returns only 1 commit', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit(`fix: commit ${i}`, 'Alice')
    );
    expect(filterCommits(commits, 1)).toHaveLength(1);
  });

  test('commit with null sha — handled gracefully', () => {
    const commit = {
      sha: null,
      commit: { message: 'feat: something', author: { name: 'Alice' } },
    };
    expect(() => filterCommits([commit])).not.toThrow();
  });

  test('commit with null commit field — filtered out (no message)', () => {
    const commit = { sha: 'abc1234', commit: null };
    expect(() => filterCommits([commit])).not.toThrow();
    expect(filterCommits([commit])).toHaveLength(0);
  });

  test('commit with null message field — filtered out', () => {
    const commit = {
      sha: 'abc1234',
      commit: { message: null, author: { name: 'Alice' } },
    };
    expect(filterCommits([commit])).toHaveLength(0);
  });
});

// ─── bumpVersion — additional corner cases ────────────────────────────────────

describe('bumpVersion — additional edge cases', () => {
  test('v0.0.0 → v0.0.1', () => {
    expect(bumpVersion('v0.0.0')).toBe('v0.0.1');
  });

  test('v10.20.30 → v10.20.31', () => {
    expect(bumpVersion('v10.20.30')).toBe('v10.20.31');
  });

  test('pre-release rc.1 suffix preserved in bump', () => {
    expect(bumpVersion('v1.0.0-rc.1')).toBe('v1.0.1-rc.1');
  });

  test('pre-release alpha suffix preserved', () => {
    expect(bumpVersion('v2.3.4-alpha')).toBe('v2.3.5-alpha');
  });

  test('tag with slash — non-semver, gets -next', () => {
    expect(bumpVersion('v1/beta')).toBe('v1/beta-next');
  });

  test('tag starting with "release/" — non-semver, gets -next', () => {
    expect(bumpVersion('release/2024-Q1')).toBe('release/2024-Q1-next');
  });

  test('numeric-only tag — non-semver (no dots), gets -next', () => {
    expect(bumpVersion('20240115')).toBe('20240115-next');
  });

  test('two-part semver tag (1.2) — non-semver, gets -next', () => {
    expect(bumpVersion('v1.2')).toBe('v1.2-next');
  });
});

// ─── buildPrompt — additional edge cases ──────────────────────────────────────

describe('buildPrompt — additional corner cases', () => {
  test('empty commit list — produces valid prompt', () => {
    const { systemPrompt, userPrompt } = buildPrompt([], 'v1.0.0', 'v1.0.1', '2024-01-15');
    expect(systemPrompt).toContain('v1.0.1');
    expect(userPrompt).toBeDefined();
    expect(typeof userPrompt).toBe('string');
  });

  test('commit with no SHA — uses 0000000 placeholder', () => {
    const commit = {
      sha: undefined,
      commit: { message: 'feat: thing', author: { name: 'Alice' } },
    };
    const { userPrompt } = buildPrompt([commit], null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('0000000');
  });

  test('commit with no author — uses "unknown"', () => {
    const commit = {
      sha: 'abcdef1234567',
      commit: { message: 'feat: thing', author: undefined },
    };
    const { userPrompt } = buildPrompt([commit], null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('unknown');
  });

  test('multiline commit message — only first line in prompt', () => {
    const commit = makeCommit('feat: add thing\n\nThis is a long description', 'Alice', 'abc1234567890');
    const { userPrompt } = buildPrompt([commit], null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('feat: add thing');
    expect(userPrompt).not.toContain('long description');
  });

  test('RTL text in commit message included in prompt', () => {
    const commit = makeCommit('fix: إصلاح مشكلة', 'Alice', 'abc1234567890');
    const { userPrompt } = buildPrompt([commit], null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('إصلاح مشكلة');
  });

  test('code blocks in message included in prompt', () => {
    const commit = makeCommit('fix: `null` pointer deref in `doThing()`', 'Alice', 'abc1234567890');
    const { userPrompt } = buildPrompt([commit], null, 'Unreleased', '2024-01-15');
    expect(userPrompt).toContain('`null`');
  });

  test('Unreleased version used in system prompt heading', () => {
    const { systemPrompt } = buildPrompt([], null, 'Unreleased', '2024-01-15');
    expect(systemPrompt).toContain('## Unreleased');
  });

  test('today date included in system prompt', () => {
    const today = '2099-12-31';
    const { systemPrompt } = buildPrompt([], null, 'Unreleased', today);
    expect(systemPrompt).toContain(today);
  });
});

// ─── prependChangelog — additional edge cases ─────────────────────────────────

describe('prependChangelog — additional corner cases', () => {
  const newSection = '## v1.2.4 — 2024-01-15\n\n### ✨ Features\n- Added dark mode';

  test('whitespace-only existing content treated as empty', () => {
    const result = prependChangelog('   \n\n  ', newSection, 'v1.2.4');
    expect(result).toContain('# Changelog');
    expect(result).toContain(newSection);
  });

  test('existing content with only the header — no older sections', () => {
    const existing = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect(result).toContain('# Changelog');
    expect(result).toContain(newSection);
    // Should only appear once
    expect((result.match(/^# Changelog/gm) || []).length).toBe(1);
  });

  test('dedup when existing entry is the only section (no next ## section)', () => {
    const existing = '# Changelog\n\n## v1.2.4 — 2024-01-14\n\n- Stale entry only';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect((result.match(/## v1\.2\.4/g) || []).length).toBe(1);
    expect(result).toContain('Added dark mode');
    expect(result).not.toContain('Stale entry only');
  });

  test('multiple existing versions — all preserved after new section', () => {
    const existing =
      '# Changelog\n\n## v1.2.3 — 2024-01-10\n\n- B\n\n## v1.2.2 — 2024-01-05\n\n- A';
    const result = prependChangelog(existing, newSection, 'v1.2.4');
    expect(result).toContain('## v1.2.3');
    expect(result).toContain('## v1.2.2');
    expect(result.indexOf('v1.2.4')).toBeLessThan(result.indexOf('v1.2.3'));
    expect(result.indexOf('v1.2.3')).toBeLessThan(result.indexOf('v1.2.2'));
  });

  test('version with special chars in header does not break dedup', () => {
    const section = '## v1.0.0-rc.1 — 2024-01-15\n\n- RC release';
    const result = prependChangelog('', section, 'v1.0.0-rc.1');
    expect(result).toContain('v1.0.0-rc.1');
  });

  test('Unreleased version dedup works', () => {
    const section1 = '## Unreleased — 2024-01-14\n\n- Old unreleased';
    const existing = `# Changelog\n\n${section1}`;
    const newUnreleased = '## Unreleased — 2024-01-15\n\n- New unreleased';
    const result = prependChangelog(existing, newUnreleased, 'Unreleased');
    expect((result.match(/## Unreleased/g) || []).length).toBe(1);
    expect(result).toContain('New unreleased');
    expect(result).not.toContain('Old unreleased');
  });
});

// ─── callOpenAIWithRetry — additional edge cases ──────────────────────────────

describe('callOpenAIWithRetry — additional corner cases', () => {
  test('empty string response — throws empty response error', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '' } }],
    });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 0, 0)
    ).rejects.toThrow('OpenAI returned an empty response');
  });

  test('whitespace-only response — throws empty response error', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: '   \n\n   ' } }],
    });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 0, 0)
    ).rejects.toThrow('OpenAI returned an empty response');
  });

  test('null choices — throws error', async () => {
    const mockCreate = jest.fn().mockResolvedValue({ choices: null });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 0, 0)
    ).rejects.toThrow();
  });

  test('extremely long response — returned intact', async () => {
    const longContent = '## v1.0.0\n\n' + '- Feature\n'.repeat(500);
    const mockCreate = jest.fn().mockResolvedValue({
      choices: [{ message: { content: longContent } }],
    });
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    const result = await callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 0, 0);
    expect(result.length).toBeGreaterThan(5000);
  });

  test('rate limit 429 error — retries and eventually throws', async () => {
    const err = new Error('429 Too Many Requests');
    err.status = 429;
    const mockCreate = jest.fn().mockRejectedValue(err);
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow('OpenAI API unavailable after 2 attempt(s)');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('500 server error — retries and eventually throws', async () => {
    const err = new Error('500 Internal Server Error');
    err.status = 500;
    const mockCreate = jest.fn().mockRejectedValue(err);
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow();
  });

  test('network failure (ECONNREFUSED) — retries and eventually throws', async () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    const mockCreate = jest.fn().mockRejectedValue(err);
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow('ECONNREFUSED');
  });

  test('timeout error (ETIMEDOUT) — retries and eventually throws', async () => {
    const err = new Error('ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    const mockCreate = jest.fn().mockRejectedValue(err);
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 1, 0)
    ).rejects.toThrow('OpenAI API unavailable after 2 attempt(s)');
  });

  test('maxRetries=2 means 3 total attempts before throwing', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('fail'));
    const mockOpenai = { chat: { completions: { create: mockCreate } } };
    await expect(
      callOpenAIWithRetry(mockOpenai, 'gpt-4o-mini', 'sys', 'user', 2, 0)
    ).rejects.toThrow('3 attempt(s)');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});

// ─── run() — extended integration tests ──────────────────────────────────────

describe('run() — environment variable edge cases', () => {
  function setupInputs({ licenseKey = '', openaiKey = 'sk-test-key' } = {}) {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return openaiKey;
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return licenseKey;
      return '';
    });
  }

  test('missing GITHUB_TOKEN → setFailed with token guidance', async () => {
    setupInputs();
    delete process.env.GITHUB_TOKEN;

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('GITHUB_TOKEN')
    );
    expect(mockRepos.get).not.toHaveBeenCalled();
  });

  test('empty openai_key input → setFailed with key guidance', async () => {
    setupInputs({ openaiKey: '' });
    // core.getInput with required:true would throw, but we have our own check
    // Simulate it returning empty (not throwing)
    core.getInput.mockImplementation((name, opts) => {
      if (name === 'openai_key') return '';
      return '';
    });

    process.env.GITHUB_TOKEN = 'test-token';

    // getInput with required:true throws when the key is missing in real actions
    // In our mock, it returns ''. The code checks: if (!openaiKey)
    // But actually core.getInput with required:true THROWS if empty.
    // Let's simulate that throw:
    core.getInput.mockImplementation((name, opts) => {
      if (name === 'openai_key' && opts && opts.required) {
        throw new Error('Input required and not supplied: openai_key');
      }
      return '';
    });

    await run();

    expect(core.setFailed).toHaveBeenCalled();
  });
});

describe('run() — license key edge cases', () => {
  function setupInputs(licenseKey = '') {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return licenseKey;
      return '';
    });
  }

  function setupPrivateRepo() {
    mockRepos.get.mockResolvedValue({ data: { private: true } });
  }

  function setupPublicRepo() {
    mockRepos.get.mockResolvedValue({ data: { private: false } });
  }

  function setupNoReleases() {
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
  }

  function setupOpenAI() {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
  }

  function setupGit() {
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
  }

  test('empty string license key on private repo → setFailed', async () => {
    setupInputs('');
    setupPrivateRepo();

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('license key')
    );
  });

  test('license key with spaces on private repo → validated against worker', async () => {
    setupInputs('  difflog_key_with_spaces  ');
    setupPrivateRepo();
    setupNoReleases();
    setupOpenAI();
    setupGit();

    const origFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, plan: 'indie' }),
    });
    global.fetch = mockFetch;

    await run();
    global.fetch = origFetch;

    // Should have called fetch with the key (including spaces — the source doesn't trim)
    expect(mockFetch).toHaveBeenCalled();
  });

  test('very long license key on private repo → validated', async () => {
    const longKey = 'difflog_' + 'x'.repeat(1000);
    setupInputs(longKey);
    setupPrivateRepo();
    setupNoReleases();
    setupOpenAI();
    setupGit();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, plan: 'indie' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('license key with special chars on private repo → validated', async () => {
    const specialKey = 'difflog_!@#$%^&*()_key';
    setupInputs(specialKey);
    setupPrivateRepo();
    setupNoReleases();
    setupOpenAI();
    setupGit();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, plan: 'indie' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

describe('run() — Worker URL edge cases', () => {
  function setupPrivateRepoWithKey(key = 'difflog_valid_key') {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return key;
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: true } });
  }

  test('Worker returns 200 valid license → continues', async () => {
    setupPrivateRepoWithKey();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ valid: true, plan: 'indie' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });

  test('Worker returns 200 but valid=false → setFailed', async () => {
    setupPrivateRepoWithKey();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ valid: false, message: 'License expired' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('License expired')
    );
  });

  test('Worker returns 400 → setFailed with validation failure', async () => {
    setupPrivateRepoWithKey();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ message: 'Invalid license key.' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('difflog.io')
    );
  });

  test('Worker returns 401 → setFailed with validation failure', async () => {
    setupPrivateRepoWithKey();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401,
      json: async () => ({ message: 'Unauthorized.' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('difflog.io'));
  });

  test('Worker returns 403 → setFailed', async () => {
    setupPrivateRepoWithKey();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ message: 'Forbidden.' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('difflog.io'));
  });

  test('Worker returns 404 → setFailed (client error)', async () => {
    setupPrivateRepoWithKey();

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({ message: 'Not found.' }),
    });

    await run();
    global.fetch = origFetch;

    expect(core.setFailed).toHaveBeenCalled();
  });

  test('Worker returns 500 → fails open with warning, continues', async () => {
    setupPrivateRepoWithKey();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({}),
    });

    await run();
    global.fetch = origFetch;

    // Should warn but NOT fail
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('500')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });

  test('Worker timeout (AbortError) → fails open with warning, continues', async () => {
    setupPrivateRepoWithKey();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(abortErr);

    await run();
    global.fetch = origFetch;

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('timed out')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });

  test('Worker network unreachable → fails open with warning, continues', async () => {
    setupPrivateRepoWithKey();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    const networkErr = new Error('getaddrinfo ENOTFOUND difflog-license.patchwork-eng.workers.dev');
    networkErr.code = 'ENOTFOUND';

    const origFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(networkErr);

    await run();
    global.fetch = origFetch;

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not reach Difflog license service')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('public repo — no license needed, fetch never called', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return '';
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: false } });
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    const origFetch = global.fetch;
    const mockFetch = jest.fn();
    global.fetch = mockFetch;

    await run();
    global.fetch = origFetch;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('repo visibility check fails → assumes public, fails open', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return '';
      return '';
    });
    mockRepos.get.mockRejectedValue(new Error('API rate limit exceeded'));
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not determine repo visibility')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith('✅ Difflog complete.');
  });
});

describe('run() — CHANGELOG.md edge cases', () => {
  function setupHappyPath({ changelog = null } = {}) {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return '';
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: false } });
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });

    if (changelog === null) {
      fs.existsSync.mockReturnValue(false);
    } else {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(changelog);
      fs.copyFileSync.mockImplementation(() => {});
      fs.unlinkSync.mockImplementation(() => {});
    }
    fs.writeFileSync.mockImplementation(() => {});

    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
  }

  test('CHANGELOG.md does not exist — creates fresh', async () => {
    setupHappyPath({ changelog: null });

    await run();

    expect(core.info).toHaveBeenCalledWith('CHANGELOG.md not found — creating it fresh.');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'CHANGELOG.md', expect.stringContaining('# Changelog')
    );
  });

  test('CHANGELOG.md exists and is empty — adds header', async () => {
    setupHappyPath({ changelog: '' });

    await run();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'CHANGELOG.md', expect.stringContaining('# Changelog')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('CHANGELOG.md has existing content — new section prepended', async () => {
    setupHappyPath({
      changelog: '# Changelog\n\n## v0.9.0 — 2024-01-01\n\n- Old stuff',
    });

    await run();

    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('## Unreleased');
    expect(written).toContain('## v0.9.0');
    expect(written.indexOf('Unreleased')).toBeLessThan(written.indexOf('v0.9.0'));
  });

  test('CHANGELOG.md write failure — backup restored, no setFailed', async () => {
    setupHappyPath({ changelog: '# Changelog\n\n- Old' });
    fs.writeFileSync.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });

    await run();

    // Should warn, not hard fail
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write CHANGELOG.md')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('no changelog and write fails — warns, no setFailed', async () => {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return '';
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: false } });
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write CHANGELOG.md')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

describe('run() — git push edge cases', () => {
  function setupForGit() {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return '';
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: false } });
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## Unreleased\n\n- Thing' } }],
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
  }

  test('git status shows no changes — skips commit', async () => {
    setupForGit();
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from(''); // no changes
      return Buffer.from('');
    });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      'No changes to CHANGELOG.md — nothing to commit.'
    );
    // Push should NOT be called
    const pushCall = execSync.mock.calls.find(c => c[0] === 'git push');
    expect(pushCall).toBeUndefined();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('git config fails — setFailed with git error message', async () => {
    setupForGit();
    execSync.mockImplementation((cmd) => {
      if (cmd.startsWith('git config')) {
        throw new Error('fatal: not a git repository');
      }
      return Buffer.from('');
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('not a git repository')
    );
  });

  test('git push fails → setFailed with contents:write guidance', async () => {
    setupForGit();
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

  test('git add fails → setFailed', async () => {
    setupForGit();
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git add CHANGELOG.md') throw new Error('git add failed');
      return Buffer.from('');
    });

    await run();

    expect(core.setFailed).toHaveBeenCalled();
  });
});

describe('run() — tag edge cases', () => {
  function setupBasic(licenseKey = '') {
    core.getInput.mockImplementation((name) => {
      if (name === 'openai_key') return 'sk-test-key';
      if (name === 'model') return 'gpt-4o-mini';
      if (name === 'max_commits') return '50';
      if (name === 'license_key') return licenseKey;
      return '';
    });
    mockRepos.get.mockResolvedValue({ data: { private: false } });
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '## v1.2.4\n\n- New stuff' } }],
    });
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
    execSync.mockImplementation((cmd) => {
      if (cmd === 'git status --porcelain') return Buffer.from('M CHANGELOG.md');
      return Buffer.from('');
    });
  }

  test('no prior releases — logs info about no releases', async () => {
    setupBasic();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: first', 'Alice', 'abc1234567890')],
    });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      'No prior releases found — generating changelog for all commits.'
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('tag found — computes next version and uses compareCommits', async () => {
    setupBasic();
    mockRepos.listReleases.mockResolvedValue({
      data: [{ tag_name: 'v1.2.3' }],
    });
    mockRepos.compareCommits.mockResolvedValue({
      data: {
        commits: [makeCommit('feat: new', 'Alice', 'abc1234567890')],
        ahead_by: 1,
        merge_base_commit: { sha: 'base123' },
      },
    });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('v1.2.3 → generating changelog for v1.2.4')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('pre-release tag v1.0.0-rc.1 → next version v1.0.1-rc.1', async () => {
    setupBasic();
    mockRepos.listReleases.mockResolvedValue({
      data: [{ tag_name: 'v1.0.0-rc.1' }],
    });
    mockRepos.compareCommits.mockResolvedValue({
      data: {
        commits: [makeCommit('fix: rc fix', 'Alice', 'abc1234567890')],
        ahead_by: 1,
        merge_base_commit: { sha: 'base123' },
      },
    });

    await run();

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('v1.0.0-rc.1 → generating changelog for v1.0.1-rc.1')
    );
  });

  test('compareCommits fails → fallback to listCommits', async () => {
    setupBasic();
    mockRepos.listReleases.mockResolvedValue({
      data: [{ tag_name: 'v1.0.0' }],
    });
    mockRepos.compareCommits.mockRejectedValue(new Error('Not Found'));
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not compare to tag v1.0.0')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('listReleases API fails → falls back to all commits with warning', async () => {
    setupBasic();
    mockRepos.listReleases.mockRejectedValue(new Error('API error'));
    mockRepos.listCommits.mockResolvedValue({
      data: [makeCommit('feat: thing', 'Alice', 'abc1234567890')],
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not fetch releases')
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  test('0 commits after filtering (all bots) → warns and returns early', async () => {
    setupBasic();
    mockRepos.listReleases.mockResolvedValue({ data: [] });
    mockRepos.listCommits.mockResolvedValue({
      data: [
        makeCommit('chore: bump deps', 'dependabot'),
        makeCommit('Merge pull request #1', 'Alice'),
      ],
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      'No commits to summarize after filtering. Skipping changelog generation.'
    );
    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
