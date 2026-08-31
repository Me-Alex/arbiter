# Contributing to Arbiter

Thank you for your interest in contributing to Arbiter! This document provides guidelines for contributing to the project.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Adding New Features](#adding-new-features)
- [Reporting Issues](#reporting-issues)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Code Review Process](#code-review-process)
- [Release Process](#release-process)

## Getting Started

Arbiter is a local-first sports arbitrage scanner for Romanian bookmakers. It uses Node.js, Electron, and TinyFish for browser automation.

### Prerequisites

- Node.js >= 20
- npm >= 9
- Git
- [TinyFish CLI](https://tinyfish.net/) for browser automation

### Quick Setup

```bash
# Clone the repository
git clone https://github.com/your-org/arbiter.git
cd arbiter

# Install dependencies
npm install

# Install TinyFish CLI globally
npm install -g @tiny-fish/cli

# Authenticate with TinyFish
tinyfish auth login

# Verify authentication
tinyfish auth status

# Start the development server
npm start

# Or start the Electron app
npm run desktop:dev
```

## Development Setup

### Environment Variables

Create a `.env` file in the project root with the following variables:

```env
PORT=3022
HOST=127.0.0.1
ARBITER_DATA_DIR=./data
ARBITER_DEV=1
TINYFISH_API_KEY=your_api_key
```

### Running the Application

- **Node.js Server**: `npm start` - Starts the HTTP server on port 3022
- **Electron App**: `npm run desktop` - Production mode
- **Electron Dev**: `npm run desktop:dev` - Development mode with DevTools

### Running Tests

```bash
npm test
```

This runs all test files in the `test/` directory using Node.js's built-in test runner.

### Linting

```bash
npm run lint
```

This runs ESLint on the source code to check for coding standard violations.

## Project Structure

```
arbiter/
├── src/                          # Main source code
│   ├── server.mjs                # Legacy monolith server (standalone entrypoint)
│   ├── server-modular.mjs        # New modular server entrypoint
│   ├── router.mjs                # HTTP routing + body parsing
│   ├── scrape-orchestrator.mjs   # Scrape + verify lifecycle
│   ├── scan-service.mjs          # Workspace scan persistence
│   ├── scheduler-service.mjs     # Recurring cycles
│   ├── tracker-service.mjs       # Bet tracker, CSV import/export, alerts
│   ├── state-broadcaster.mjs     # SSE clients + heartbeat
│   ├── scraper-service.mjs       # Runs ScraperBase child processes
│   ├── verification.mjs          # Re-scrape only involved books
│   ├── cron-service.mjs         # Scheduled cleanup tasks
│   ├── scanner/                  # Scanning and arbitrage detection
│   │   ├── scanner.mjs           # Main scanner entry point
│   │   ├── engine.mjs            # Matching + arb/middle math
│   │   ├── bookmaker-signals.mjs # Positive EV + low hold detection
│   │   ├── bankroll-allocation.mjs
│   │   └── market-catalog.mjs    # Market definitions
│   ├── scrapers/                 # One file per bookmaker
│   │   ├── base.mjs              # ScraperBase contract
│   │   ├── provider-contract.mjs # Swappable parser
│   │   ├── altenar-provider.mjs  # Shared Altenar parser
│   │   ├── altenar-sites.mjs     # Don/TopBet/Million/Baumbet/Winbet
│   │   ├── superbet.mjs
│   │   ├── betano.mjs
│   │   └── ...
│   ├── tinyfish/                 # Browser automation
│   │   ├── books.mjs            # Bookmaker configurations
│   │   ├── browser-discovery.mjs
│   │   ├── client.mjs
│   │   ├── discovery.mjs
│   │   ├── extract.mjs
│   │   └── normalize.mjs
│   └── shared/                   # Shared utilities
│       ├── atomic-write.mjs
│       ├── errors.mjs
│       ├── graceful-shutdown.mjs
│       ├── lock.mjs
│       ├── rate-limit.mjs
│       ├── sanitize.mjs
│       └── security.mjs
├── electron/                     # Electron desktop application
│   ├── main.mjs                 # Electron main process
│   ├── preload.mjs              # Preload script (context bridge)
│   └── auto-update.mjs          # Auto-update functionality
├── public/                      # Static files (dashboard, admin)
│   ├── index.html               # Main dashboard
│   ├── admin/                   # Admin pages
│   ├── css/                     # Stylesheets
│   └── js/                      # Client-side JavaScript
│       ├── api.js               # API client
│       ├── app.js               # App layout and sidebar
│       ├── i18n.js              # Internationalization
│       ├── sse.js               # Server-Sent Events client
│       └── pages/                # Page-specific JavaScript
├── config/                      # Configuration files
│   ├── scrapers.json            # Scraper registry
│   └── scan-profiles.json       # Scan profile configurations
├── scripts/                     # Utility scripts
│   ├── cleanup.mjs              # Cleanup script
│   ├── diagnose-tinyfish-books.mjs
│   ├── discover-smoke.mjs
│   ├── smoke.mjs
│   └── tinyfish-smoke.mjs
├── data/                        # Runtime data (gitignored)
│   ├── workspace/               # Workspace files
│   ├── staging/                 # Staging files
│   ├── backups/                # Backup files
│   └── discovery/               # Discovered links
├── test/                        # Test files
│   └── *.test.mjs               # Test suites
├── package.json
├── README.md
└── CONTRIBUTING.md
```

## Coding Standards

### General Guidelines

- Use **ESM modules** (import/export syntax)
- Use **pure Node.js** (no TypeScript, no bundler, no transpilation)
- Follow **consistent naming**: `camelCase` for variables and functions, `PascalCase` for classes
- Use **async/await** for asynchronous operations
- Always **handle errors** appropriately
- Write **self-documenting code** with clear variable and function names

### Code Style

- **Indentation**: 2 spaces (configured in .eslintrc.json)
- **Line length**: Maximum 120 characters
- **Quotes**: Single quotes for strings, double quotes for JSON
- **Semicolons**: Required
- **Braces**: Required for all blocks (even single statements)

### Error Handling

- Use custom error classes from `src/shared/errors.mjs`
- Always include meaningful error messages
- Use appropriate HTTP status codes for API errors
- Log errors with context for debugging

### Security

- Validate all user input
- Sanitize output to prevent XSS
- Use CSRF protection for mutations
- Restrict API access to loopback by default
- Use atomic writes for file operations

## Testing

### Test Structure

- Test files are named `*.test.mjs` and placed in the `test/` directory
- Use Node.js's built-in test runner (`node --test`)
- Tests should be isolated and not depend on external services

### Writing Tests

```javascript
import { test, describe, it, expect } from 'node:test';
import { myFunction } from '../src/my-module.mjs';

describe('myFunction', () => {
  it('should return expected result', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });

  it('should throw on invalid input', () => {
    expect(() => myFunction(null)).toThrow();
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
node --test test/my-test.test.mjs

# Run with coverage (requires additional setup)
node --test --experimental-test-coverage test/*.test.mjs
```

## Adding New Features

### Adding a New Bookmaker

1. **Add browser configuration** in `src/tinyfish/books.mjs`:

```javascript
newbook: {
  id: 'newbook',
  name: 'Newbook',
  baseUrl: 'https://newbook.example/sport/football',
  liveUrl: 'https://newbook.example/live/football',
  discoveryStrategy: 'browser-only',
  eventUrlPattern: '[/]event[/]',
  tournamentUrlPattern: '[/]league[/]',
  maxMatches: 20,
}
```

2. **Add scraper configuration** in `config/scrapers.json`:

```json
{
  "id": "newbook",
  "name": "Newbook (TinyFish)",
  "enabled": true,
  "engine": "tinyfish",
  "script": "tinyfish-scraper.mjs",
  "sourceIds": ["newbook"]
}
```

3. **Test the configuration**:

```bash
npm run tinyfish:discover -- newbook 10
npm run tinyfish:smoke -- newbook 2
```

### Adding a New API Endpoint

1. Add the route handler in `src/router.mjs`
2. Add any necessary business logic in the appropriate service
3. Add tests for the new endpoint

### Adding a New Dashboard Page

1. Create the HTML file in `public/admin/`
2. Create the JavaScript file in `public/js/pages/`
3. Add the page to the sidebar navigation in `public/js/app.js`

## Reporting Issues

When reporting issues, please include:

- **Node.js version** (`node --version`)
- **npm version** (`npm --version`)
- **Operating system** and version
- **Steps to reproduce** the issue
- **Expected behavior**
- **Actual behavior**
- **Error messages** (if any)
- **Relevant logs**

## Pull Request Guidelines

1. **Fork the repository** and create a feature branch
2. **Follow coding standards** as described above
3. **Write tests** for new functionality
4. **Update documentation** if needed
5. **Keep commits atomic** - each commit should represent a single logical change
6. **Write clear commit messages** - use imperative mood ("Add feature", not "Added feature")

### Commit Message Format

```
feat: add new bookmaker support

- Add configuration for Newbook
- Add scraper implementation
- Add tests for Newbook scraper

BREAKING CHANGE: None
```

### Pull Request Template

```markdown
## Description

[Brief description of the changes]

## Related Issues

[List any related issues]

## Changes Made

- [ ] New feature
- [ ] Bug fix
- [ ] Documentation update
- [ ] Test addition/improvement
- [ ] Refactoring
- [ ] Performance improvement

## Testing

- [ ] All existing tests pass
- [ ] New tests added for new functionality
- [ ] Manual testing completed

## Checklist

- [ ] Code follows project coding standards
- [ ] All tests pass
- [ ] Documentation updated
- [ ] No breaking changes (or documented if there are)
```

## Code Review Process

1. **Initial Review**: Maintainer reviews the PR for completeness and adherence to guidelines
2. **Automated Checks**: CI runs tests and linting
3. **Technical Review**: Detailed review of code quality, security, and performance
4. **Approval**: PR is approved and merged
5. **Release**: Changes are included in the next release

## Release Process

### Versioning

Arbiter uses [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Release Steps

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Create a Git tag: `git tag vX.Y.Z`
4. Push the tag: `git push origin vX.Y.Z`
5. Create a GitHub release with release notes
6. Publish to npm (if applicable)

### Update Feed

For Electron auto-updates, maintain a update feed at the URL specified in `electron/auto-update.mjs`. The feed should follow the [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) format.

## Additional Resources

- [Node.js Documentation](https://nodejs.org/en/docs/)
- [Electron Documentation](https://www.electronjs.org/docs)
- [TinyFish Documentation](https://tinyfish.net/docs)
- [ESLint Documentation](https://eslint.org/docs)

## License

By contributing to Arbiter, you agree that your contributions will be licensed under the same license as the project (MIT).

---

Thank you for contributing to Arbiter! Your contributions help make this project better for everyone.
