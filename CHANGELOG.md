# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-17

### ✨ Features
- A new Cloudflare Worker has been added for license validation, which integrates real validation in the Action.
- Marketplace branding has been enhanced along with a pagination fix, Sentry integration, and a new subscribe page.
- Usage logging has been implemented for KV on successful validation, along with a stub for the Resend email hook during checkout.
- Stripe payment links have been wired to the pricing cards and the subscribe page for improved user experience.
- The Resend email delivery for license keys has been integrated to streamline the licensing process.

### 🐛 Bug Fixes
- Error handling has been hardened, and the license skeleton has been added to improve overall robustness and test coverage.
- The internal email address has been updated to hello@difflog.io across all pages to ensure consistent communication.
- The Worker validation URL has been updated to point to api.difflog.io, ensuring correct API routing.

### 🔧 Chores & Maintenance
- The README file has been added with comprehensive usage instructions, enhancing documentation for users.
- A privacy policy and terms of service have been documented to comply with legal requirements.
- The refund policy has been added to the terms of service, providing clarity to users regarding refunds.
- A Jest test suite has been introduced, along with additional tests to cover edge cases for both the Action and Worker, ensuring better reliability. 
- The Worker configuration has been updated with the real KV ID and the correct API route for improved functionality.
