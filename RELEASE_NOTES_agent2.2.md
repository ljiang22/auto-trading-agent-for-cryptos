# Release Notes: Agent 2.2

## Overview

This release introduces major UI/UX improvements, a comprehensive favorite task chains system, enhanced user management features, and significant refinements to the core task chain functionality. The update brings a modern glassmorphism design system, improved user engagement features, and better performance optimizations.

---

## 🎉 Major Features

### Favorite Task Chains System
- **Save and Manage Task Chains**: Users can now save frequently used task chains as favorites for quick access
- **Share Task Chains**: Share task chains with other users via 10-character share codes
- **Personalization**: Favorite task chains can be personalized with custom names and descriptions
- **Graph View Integration**: Favorite task chains are seamlessly integrated into the task chain graph view
- **Database Support**: New database tables (`favorite_task_chains`, `shared_task_chains`) for persistent storage

### Modern Glassmorphism UI Design
- **Comprehensive Design System**: New glassmorphism style guide with consistent theming across light and dark modes
- **Floating UI Elements**: Chat input and user button redesigned with floating glassmorphism effects
- **Pro User Theme**: Exclusive macaron gradient theme for Pro users across UI components
- **Enhanced Visual Hierarchy**: Improved sticky positioning for task chain headers and better scroll behavior
- **Theme-Aware Components**: All glassmorphism effects properly support both light and dark modes with graceful fallbacks

### User Management & Engagement
- **Settings Dialog**: New comprehensive settings dialog with Account and Payment management sections
- **Referral System**: Share with friends functionality to invite new users
- **Daily Message Limits**: Anonymous users now have a 5 message/day limit with upgrade prompts
- **Room Management**: 
  - Room ranking functionality
  - Room name update capability
  - Improved room selector UI

### Enhanced Task Chain Experience
- **Automatic Table of Contents**: Task messages now automatically generate table of contents for better navigation
- **Side-by-Side TOC Layout**: Redesigned comprehensive analysis with improved TOC layout
- **Persistent Graph View**: Task chain graph view now persists across interactions
- **Smart Sticky Positioning**: Task chain headers use intelligent sticky positioning
- **Improved Approval Flow**: More compact and user-friendly task chain approval UI

### Chart & Visualization Improvements
- **Chart Embedding**: New chart embedding functionality with improved sidebar
- **Chart Direction Fix**: Fixed chart direction function for better data visualization
- **Cleaner Line Charts**: Removed point markers from sentiment and price line charts for cleaner appearance
- **Theme Support**: Charts now properly support theme changes

---

## ✨ Features

### Client/UI Enhancements
- Add collapsible sidebar with icon-only mode for better space utilization
- Add collapsible chat input area with hover expand functionality
- Add comprehensive FAQ page with standalone layout
- Add Pro user macaron gradient theme across UI components
- Enhance ToC and TaskChainGraph components with better navigation
- Improve UI table rendering and TOC navigation
- Add chart embedding and improve UI with theme support
- Enhance light mode with glassmorphism and UI improvements
- Improve TOC scroll positioning and compact task chain approval UI
- Redesign comprehensive analysis with side-by-side TOC layout
- Replace header with floating glassmorphism user button
- Convert chat input to floating glassmorphism design
- Move share with friends button to sidebar
- Improve pricing cards with interactive hover effects

### Task Chain & Core Features
- Add favorite task chains management system
- Add favorite task chains to graph view and improve duplicate handling
- Add share functionality for favorite task chains
- Add smart sticky positioning for task chain headers
- Redesign task chain display with persistent graph view
- Add automatic table of contents for task messages
- Enhance favorite task chain updates to include name and description
- Improve markdown handling in task execution results
- Add intelligent query expansion for WebSearch action

### Authentication & User Experience
- Improve registration form UX with optional field emphasis
- Improve registration form layout and date of birth handling
- Change "dob" field label to "date of birth" for clarity
- Show login buttons after user logout

### Plugin & Integration Updates
- Update web search plugin configuration
- Improve chart generation and display

---

## 🐛 Bug Fixes

### Client Fixes
- Fix reliable scroll to last user message on room change
- Fix the TOC and sticky header positioning issues
- Fix chart direction function
- Clean up unused imports and add type safety checks
- Show login buttons after user logout

### Task Chain Fixes
- Fix the two actions' streaming issue
- Fix task chain handler to properly handle favorite chains with empty text messages
- Improve markdown handling in task execution results

### Chart & Visualization Fixes
- Hide point markers on sentiment and price line charts
  - Set dataset pointRadius/pointHoverRadius to 0 for line series
  - Add Chart.js options.elements.point.radius=0 globally for cleaner lines
  - Applies to sentiment and price lines in generated chart HTML

### Other Fixes
- Remove the access logger when user logs out

---

## 🔄 Refinements & Improvements

### Code Quality
- Refine chat.tsx for simplification and better maintainability
- Simplify sticky positioning and refine glassmorphism effects
- Enhance glassmorphism effects and UI consistency
- Improve glassmorphism styling throughout the application

### Performance
- Optimize rendering with better component organization
- Improve scroll performance with better positioning logic
- Enhance theme switching performance

---

## 📊 Technical Changes

### Database Schema
- New tables: `favorite_task_chains`, `shared_task_chains`
- Enhanced SQLite adapter with favorite chain management methods
- Improved data persistence for user preferences

### Core Architecture
- Enhanced task chain planner with favorite chain personalization
- Improved task chain handler with better streaming support
- Better memory management for task chain resources
- Enhanced database adapter with new query methods

### API Changes
- New endpoints for favorite task chain management
- Enhanced task chain sharing API
- Improved streaming API for real-time updates

### Type Definitions
- New types: `FavoriteTaskChainRecord`, `SharedTaskChainRecord`, `ContentWithUser`
- Enhanced type safety across chat components
- Better TypeScript definitions for task chain data

---

## 📝 Documentation

- Add comprehensive glassmorphism style guide (`docs/glass-style-guide.md`)
- Document design system principles and patterns
- Provide templates for consistent glassmorphism implementation

---

## 🔧 Developer Notes

### Breaking Changes
- Database schema changes require migration for existing installations
- Some API endpoint changes may require client updates

### Migration Guide
If upgrading from a previous version:
1. Run database migrations for new `favorite_task_chains` and `shared_task_chains` tables
2. Clear browser cache to ensure new UI components load correctly
3. Review any custom task chain implementations for compatibility

### Dependencies
- No major dependency version changes
- Ensure all workspace dependencies are updated: `pnpm install`

---

## 📈 Statistics

- **Files Changed**: 70
- **Lines Added**: 11,853
- **Lines Removed**: 2,941
- **Net Change**: +8,912 lines
- **Commits**: 40+

---

## 🙏 Acknowledgments

Thank you to all contributors who made this release possible. This update represents a significant step forward in user experience and functionality.

---

## 📋 Upgrade Instructions

1. **Pull the latest changes**:
   ```bash
   git pull origin agent2.2
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Run database migrations** (if applicable):
   - Check database schema updates
   - Backup existing data before migration

4. **Build the project**:
   ```bash
   pnpm build
   ```

5. **Test the installation**:
   ```bash
   pnpm test
   ```

6. **Start the application**:
   ```bash
   pnpm dev
   ```

---

## 🎯 What's Next

Future releases will continue to focus on:
- Enhanced task chain intelligence
- Additional user customization options
- Performance optimizations
- Expanded plugin ecosystem
- Improved documentation and developer experience

---

**Release Date**: [To be filled]  
**Branch**: `agent2.2`  
**Base**: `main`

