# Release Notes: Agent 2.8.0

## Overview

This release focuses on core reliability and agent intelligence upgrades, including a full Action Cache system with LangGraph integration, improved iterative web search and chat attachments, a new Solana Launchpad data plugin, and broad schema/metadata standardization across plugins and task-chain workflows.

---

## 🎉 Major Features

### Action Cache system (LangGraph-integrated)
- **Action Cache foundation**: Complete Action Cache pipeline integrated with LangGraph workflows
- **Two-phase retrieval**: Intelligent two-phase search for improved cache hits and relevance
- **Optimized chunking**: Better chunking and retrieval utilities for consistent reuse of action outputs
- **Reusable templates**: New templates/utilities to standardize cached results across workflows

### Improved iterative web search + chat attachments
- **Better chat attachments UX**: Improvements to attachment handling and message processing
- **Iterative search analysis**: Enhanced iterative web search analysis loop for higher quality results
- **Web search image display**: Improved image rendering and safer defaults (including limiting returned images)

### New plugin: Launchpad (Solana early-stage token data)
- **New package**: Add `packages/plugin-launchpad`
- **Launchpad data actions**: Utilities and actions for early-stage token and launchpad-related data

---

## ✨ Features

### Core / Task-chain intelligence
- Add complete Action Cache system with LangGraph integration
- Add intelligent two-phase search and optimized chunking for cached retrieval
- Standardize action response schema and action metadata access patterns
- Improve task chain sharing by removing execution payloads from shared taskchains

### Client / UI
- Improve sticky positioning and general UI behavior refinements
- Fix upgrade button routing to correctly navigate to the upgrade plan page

### Plugins / Data
- Add Launchpad plugin for Solana early-stage token data
- Replace Yahoo Finance usage with Coinglass API in relevant crypto data flows

### Developer Experience
- Add autotest script and a question-based test harness under `tests/questions/`
- Add PM2 ecosystem configuration for easier production process management
- Fix build/dependency issues (including `@types/node` packaging and `turbo.json` dependency corrections)

---

## 🐛 Bug Fixes

- Fix Sentiscore time period handling
- Fix Coinglass parameter handling in sentiment analysis
- Reduce request payload risk by limiting web search images and improving request sizing

---

## 🔄 Refinements & Improvements

### Code Quality
- Refactor and standardize plugin metadata access for consistency
- Standardize action response schema across plugins to reduce drift and parsing issues

---

## 🔧 Developer Notes

### Notable Removals
- Removed `packages/plugin-bootstrap`. If you depended on it directly, remove it from your dependency graph and update any imports/usages.

### Compatibility Notes
- If you maintain custom plugins/actions, review outputs for compatibility with the standardized action response schema and metadata access patterns.

---

## 📋 Upgrade Instructions

1. **Pull the latest changes**:
   ```bash
   git pull
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Build the project**:
   ```bash
   pnpm build
   ```

4. **Test the installation**:
   ```bash
   pnpm test
   ```

5. **Start the application**:
   ```bash
   pnpm dev
   ```

---

## 📈 Statistics (since `v2.7.0`)

- **Commits**: 60
- **Files changed**: 206
- **Insertions**: 17,385
- **Deletions**: 21,390
- **Net change**: -4,005

---

**Release Date**: [To be filled]  
**Version**: `v2.8.0`

