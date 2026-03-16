# Changelog

All notable changes to this project will be documented in this file.

## v1.0.1 — 2026-03-16

### ⚠️ Breaking Changes
- None.

### ✨ Features
- A new Cloudflare Worker has been added for license validation, which integrates real validation into the Action workflow. This enhancement improves the security and reliability of license checks. (Kai (Difflog))
- Marketplace branding has been introduced along with a pagination fix, integration of Sentry for error tracking, and a new subscribe page to enhance user engagement. (Kai (Difflog CTO))
- Usage logging has been implemented for the KV store upon successful validation, and a stub for the Resend email hook has been created during the checkout process. This feature aims to streamline user interactions and improve tracking. (patchwork-eng)

### 🐛 Bug Fixes
- Error handling has been hardened to ensure more robust performance, alongside the addition of a license skeleton and improvements to test coverage. This fix enhances the overall stability of the application. (Kai (Difflog CTO))

### 🔧 Chores & Maintenance
- The README file has been updated with usage instructions to assist users in navigating the application effectively. (patchwork-eng)
- A privacy policy and terms of service have been added to ensure compliance and inform users of their rights. (patchwork-eng)
- The refund policy has been incorporated into the terms of service to clarify the process for users. (patchwork-eng)
- A Jest test suite has been added, and the Action has been hardened against edge cases, contributing to better test coverage and reliability. (patchwork-eng)
- The README.md and docs/CNAME files have been restored after being accidentally dropped in a previous push. (patchwork-eng)
