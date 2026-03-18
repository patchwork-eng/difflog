# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-18

### ✨ Features
- Added a Cloudflare Worker for license validation and integrated real validation in the Action, enhancing the security and functionality of the application.
- Implemented Marketplace branding and pagination fixes, along with Sentry integration and a new subscribe page to improve user experience and tracking.
- Introduced usage logging to the KV on successful validation and stubbed a Resend email hook during checkout, streamlining the user onboarding process.
- Wired Stripe payment links to pricing cards and the subscribe page, allowing for a seamless payment experience.
- Enabled live Stripe payment links to ensure users can make transactions in real-time.
- Added a "Get started free" call-to-action to the Free pricing card, encouraging user engagement.

### 🐛 Bug Fixes
- Hardened error handling throughout the application, improving the robustness of the system.
- Replaced the internal email address with hello@difflog.io across all pages to ensure consistent communication.
- Updated the Worker validation URL to point to api.difflog.io, fixing potential issues with API calls.

### 🔧 Chores & Maintenance
- Restored the README.md and docs/CNAME files that were accidentally dropped in a previous push, ensuring proper documentation is available.
- Added a privacy policy and terms of service to the documentation, providing users with necessary legal information.
- Included a refund policy in the terms of service to clarify the company's stance on refunds.
- Conducted an audit pass on March 18, confirming the application's compliance and stability.
- Added a Jest test suite and improved test coverage with 142 new corner case tests for both the Action and Worker, enhancing the reliability of the codebase.
