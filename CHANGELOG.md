# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ✨ Features
- A Cloudflare Worker has been added for license validation, along with real validation wired up in the Action, enhancing the overall security and reliability of the application.
- Marketplace branding has been improved, and pagination issues have been fixed. Additionally, Sentry has been integrated for better error tracking, and a new subscribe page has been introduced.
- Usage logging has been implemented in the KV store on successful validation, and a stub for the Resend email hook has been added during the checkout process.

### 🐛 Bug Fixes
- Error handling has been hardened, and a license skeleton has been added to improve test coverage, ensuring a more robust application.

### 🔧 Chores & Maintenance
- A README file has been created with usage instructions, providing users with clear guidance on how to utilize the application.
- The documentation has been updated to include a privacy policy, terms of service, and a refund policy, ensuring compliance and transparency for users.
- A landing page for difflog.io has been established via GitHub Pages, enhancing the project's online presence.
- The Worker configuration has been updated with the real KV ID and the api.difflog.io route, optimizing the application's performance and functionality.
