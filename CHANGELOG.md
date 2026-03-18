# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-18

### ✨ Features
- Added a Cloudflare Worker for license validation and integrated real validation in the Action, enhancing the security of license checks.
- Implemented Marketplace branding and pagination fixes, along with the integration of Sentry for improved error tracking and a new subscribe page.
- Introduced usage logging to KV on successful validation and set up a stub for the Resend email hook during checkout.
- Wired Stripe payment links to pricing cards and the subscribe page, facilitating easier transactions for users.
- Enabled email delivery for license keys through Resend, streamlining the licensing process.

### 🐛 Bug Fixes
- Hardened error handling within the application, added a license skeleton, and improved overall test coverage to ensure robustness.
- Replaced the internal email address with hello@difflog.io across all pages to standardize communication.
- Updated the Worker validation URL to point to api.difflog.io, ensuring correct routing for validation requests.

### 🔧 Chores & Maintenance
- Added a README file with usage instructions to assist users in understanding the project better.
- Restored the README.md and docs/CNAME files that were accidentally dropped in a previous push.
- Added a privacy policy and terms of service to provide clarity on user data handling and service usage.
- Documented the refund policy within the terms of service to inform users about their rights.
- Conducted an audit pass on March 18, confirming compliance and operational integrity.
- Expanded the test suite with 142 new corner case tests for both the Action and Worker, enhancing the reliability of the application.
