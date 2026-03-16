# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ✨ Features
- A new Cloudflare Worker has been added for license validation, which is now integrated into the Action for real-time validation.
- Marketplace branding has been improved, along with a pagination fix, the addition of Sentry for error tracking, and a new subscribe page.
- Usage logging has been implemented for the KV store on successful validation, along with a stub for the Resend email hook during checkout.
- Stripe payment links have been wired to the pricing cards and the subscribe page, enhancing the payment process for users.

### 🐛 Bug Fixes
- Error handling has been hardened, and improvements have been made to the overall test coverage of the application.

### 🔧 Chores & Maintenance
- A README file has been added, providing usage instructions for users.
- The landing page for difflog.io has been created and is now hosted via GitHub Pages.
- The privacy policy and terms of service documents have been updated, including a new refund policy.
- The Worker configuration has been updated with the real KV ID and the api.difflog.io route.
- A Jest test suite has been added to ensure better coverage and to harden the Action against edge cases.
- The license skeleton has been added to the project.
