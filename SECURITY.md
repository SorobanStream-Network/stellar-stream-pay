# Security Policy

Thank you for helping keep **StellarStream-Pay** safe. This document explains how
to report a vulnerability and what you can expect from the maintainers.

## Supported versions

Only the latest release of `main` is actively maintained. We do not backport
fixes to historical tags.

| Version   | Supported          |
|-----------|--------------------|
| `main`    | :white_check_mark: |
| < 0.1.0   | :x:                |

## Reporting a vulnerability

> **Do not open a public issue** for a security bug. Report it privately through
> one of the channels below, in order of preference.

1. **GitHub Private Vulnerability Reporting** *(preferred)*
   Go to the repository's **Security → Report a vulnerability** tab. This opens a
   private channel with the maintainers and supports coordinated disclosure.

2. **Email**
   Send a message to the maintainers at `security@stellarstreampay.example`
   *(replace with the project's real address)* with the details listed below.

### What to include

A good report lets us reproduce and fix quickly. Please include:

- **Component & version** — the affected file/feature (e.g. `contracts/src/lib.rs`,
  `backend/src/index.js`, `frontend/src/lib/soroban.ts`) and the commit or tag.
- **Description** — the nature of the issue (fund loss, auth bypass, DoS, …).
- **Steps to reproduce** — a minimal test case, contract call, or transaction sequence.
- **Impact** — who is affected, under what conditions, and the worst-case outcome.
- **Suggested fix** *(optional)* — always appreciated.

### What to expect

1. **Acknowledgment** within 5 business days.
2. **Triage** — we confirm the issue and assign a severity (Critical / High / Medium / Low).
3. **Fix** — a patch is prepared and tested; we coordinate the release with you.
4. **Disclosure** — we publish an advisory after the fix ships, crediting you
   (unless you prefer to remain anonymous).

## Scope

**In scope**

- `contracts/` — the Soroban streaming contract and its tests.
- `backend/` — the Express indexer / API.
- `frontend/` — the React + Freighter DApp.

**Out of scope**

- Issues in public **Testnet** deployments (no real funds at risk).
- Social engineering, phishing, or physical attacks.
- Bugs in third-party dependencies — report those upstream, though we still want
  to hear about exploitable configurations.
- Low-severity hygiene issues (e.g. missing security headers) without a concrete
  exploit path.

## Safe harbor

We follow a good-faith disclosure model:

- We will not pursue legal action against researchers acting in good faith who
  avoid harming users, exfiltrating data, or disrupting service.
- Please give us a reasonable window before public disclosure (suggested 90 days,
  or 30 days for low-severity issues).
- Test against your own deployments or Testnet only — never against Mainnet user funds.

## Acknowledgement

Every report is appreciated. Researchers are credited in advisories and release
notes unless they ask to remain anonymous.
