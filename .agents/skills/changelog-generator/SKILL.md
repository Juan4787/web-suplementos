---
name: changelog-generator
description: >-
  Draft release notes from project changes. Use when generating changelogs, summarizing git commits and PRs, preparing version releases, or documenting recent features and bug fixes.
---

# Changelog Generator

Systematic process for analyzing git history, categorizing changes according to Conventional Commits, and drafting user-friendly changelogs following the Keep a Changelog standard.

## 1. Inspecting Git History

Determine the range of commits to include (e.g. from the last release tag to `HEAD`):

```bash
# List recent tags
git tag --sort=-creatordate | head -n 5

# View commit log with titles and hashes between tags or range
git log <last-tag>..HEAD --oneline --no-merges

# Group commits by type
git log --pretty=format:"%s (%h)" -n 50
```

## 2. Commit Categorization Matrix

Categorize commits using standard Conventional Commit prefixes:

| Prefix | Category | Keep a Changelog Section |
| :--- | :--- | :--- |
| `feat:` | New Features | **Added** |
| `fix:` | Bug Fixes | **Fixed** |
| `refactor:`, `perf:` | Improvements & Performance | **Changed** |
| `deprecate:` | Deprecations | **Deprecated** |
| `remove:` | Breaking Deletions | **Removed** |
| `security:` | Security Fixes / Patches | **Security** |
| `docs:`, `chore:`, `test:` | Maintenance | **Maintenance / Internal** |

## 3. Changelog Template Structure

```markdown
# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - YYYY-MM-DD

### 🚀 Added
- Support for multiple payment gateways in checkout flow.
- Filter products by dietary tags (gluten-free, vegan).

### ⚡ Changed
- Optimized product listing query to reduce initial load time by 40%.
- Refactored cart state management with Zustand.

### 🐛 Fixed
- Resolved checkout total calculation mismatch when applying percentage coupons.
- Fixed mobile drawer menu touch scroll freeze.

### 🔒 Security
- Sanitized user input in profile update endpoint.
- Updated vulnerable dependency versions.
```

## 4. Semantic Versioning (SemVer) Determination

- **PATCH** (`1.0.X`): Backward-compatible bug fixes (`fix:`).
- **MINOR** (`1.X.0`): Backward-compatible new functionality (`feat:`).
- **MAJOR** (`X.0.0`): Incompatible API changes, breaking changes (`BREAKING CHANGE:` or `!:`).
