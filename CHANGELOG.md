# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ✨ Features
- Introduced a Cloudflare Worker for license validation and integrated real validation within the Action, enhancing the security and reliability of license checks.
- Added Marketplace branding along with pagination fixes, improved Sentry integration, and a new subscribe page to enhance user experience.
- Implemented usage logging to the KV store upon successful validation and created a stub for the Resend email hook during checkout, improving tracking and communication.
- Connected Stripe payment links to pricing cards and the subscribe page, simplifying the payment process for users.
- Enabled email delivery for license keys through Resend, streamlining the distribution of licenses to users.

### 🐛 Bug Fixes
- Hardened error handling mechanisms throughout the application, added a license skeleton, and improved overall test coverage to ensure robustness and reliability.

### 🔧 Chores & Maintenance
- Added a comprehensive README with usage instructions to assist users in navigating the project.
- Restored the README.md and docs/CNAME files that were inadvertently dropped in a previous push, ensuring all documentation is intact.
- Updated the privacy policy and terms of service to reflect current practices and legal requirements.
- Added a refund policy to the terms of service, providing clarity on user rights.
- Established a Jest test suite and fortified the Action against edge cases, enhancing the testing framework for future development.
- Updated the Worker configuration with the actual KV ID and the api.difflog.io route to ensure proper functionality.
