# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ⚠️ Breaking Changes
None.

### ✨ Features
- Introduced a Cloudflare Worker for license validation, enhancing the Action with real validation capabilities. 
- Added usage logging to the KV on successful validation and set up a stub for the Resend email hook during checkout.
- Integrated Stripe payment links with the pricing cards and subscribe page, streamlining the payment process.
- Implemented email delivery for license keys via the Resend service.
- Enhanced the Marketplace with branding updates and pagination fixes, along with the addition of a subscribe page.

### 🐛 Bug Fixes
- Improved error handling throughout the application, ensuring a more robust user experience.
- Replaced the internal email address with hello@difflog.io across all pages to ensure consistent communication.
  
### 🔧 Chores & Maintenance
- Restored the README.md and docs/CNAME files that were accidentally dropped in a previous push.
- Added a privacy policy and terms of service to the documentation.
- Included a refund policy in the terms of service for better clarity.
- Established a Jest test suite to improve code quality and coverage, particularly focusing on edge cases.
- Updated the Worker configuration with the real KV ID and the api.difflog.io route for better functionality.
