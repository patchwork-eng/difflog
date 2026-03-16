# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ✨ Features
- Added a Cloudflare Worker for license validation and integrated real validation in the Action, enhancing the overall functionality of the application. (Kai (Difflog))
- Implemented Marketplace branding and pagination fixes, along with Sentry integration and a new subscribe page to improve user experience. (Kai (Difflog CTO))
- Introduced usage logging to the KV on successful validation and created a stub for the Resend email hook during checkout. (patchwork-eng)
- Connected Stripe payment links to the pricing cards and subscribe page, streamlining the payment process for users. (patchwork-eng)
- Enabled Resend email delivery for license keys, facilitating better communication with users. (patchwork-eng)

### 🐛 Bug Fixes
- Hardened error handling in the application, added a license skeleton, and improved test coverage to ensure robustness. (Kai (Difflog CTO))
- Replaced the internal email address with hello@difflog.io across all pages to ensure correct contact information is displayed.

### 🔧 Chores & Maintenance
- Restored the README.md and docs/CNAME files that were accidentally dropped in an earlier push, ensuring proper documentation is available.
- Added a privacy policy and terms of service to the documentation, providing users with necessary legal information.
- Included a refund policy in the terms of service to clarify user rights.
- Added a Jest test suite and strengthened the Action against edge cases, improving the reliability of the application.
- Conducted extensive testing by adding 142 new corner case tests for both the Action and Worker, enhancing overall test coverage.
