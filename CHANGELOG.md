# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-18

### ✨ Features
- Added a Cloudflare Worker for license validation and integrated real validation in the Action to enhance security and reliability. 
- Implemented Marketplace branding and fixed pagination issues, along with integrating Sentry for improved error tracking on the subscribe page.
- Introduced usage logging to the KV store upon successful validation and set up a stub for the Resend email hook during checkout.
- Wired Stripe payment links to the pricing cards and subscribe page, facilitating smoother payment processes.
- Enabled the delivery of license keys via Resend email service, improving user experience during license acquisition.
- Switched to live Stripe payment links to ensure that transactions are processed in real-time.

### 🐛 Bug Fixes
- Hardened error handling across the application, added a license skeleton, and improved overall test coverage to ensure robustness.
- Replaced the internal email address with hello@difflog.io across all pages to ensure consistent communication.
- Updated the Worker validation URL to point to the correct endpoint at api.difflog.io, fixing potential connectivity issues.

### 🔧 Chores & Maintenance
- Restored the README.md and docs/CNAME files that were accidentally dropped in an earlier push, ensuring proper documentation and site configuration.
- Added a privacy policy and terms of service to the documentation, providing users with essential information regarding their data and usage rights.
- Included a refund policy in the terms of service to clarify the conditions under which refunds may be issued.
- Conducted a comprehensive audit, confirming that the application passed all checks as of March 18. 
- Expanded the test suite with 142 new corner case tests for both Action and Worker, enhancing the reliability of the codebase.
