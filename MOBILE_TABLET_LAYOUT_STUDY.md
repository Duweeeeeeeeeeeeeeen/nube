# Nube Mobile and Tablet Layout Study

## Goal

Nube should not shrink the desktop dashboard into a phone. It should keep the same product logic and data, but present the workflows differently by viewport.

The core product remains:
- Capture anything quickly.
- Review what needs attention.
- Retrieve by search, tags, collections, dates, places, money, files, and audio.
- Configure account, connections, plugins, privacy, and billing.

## Current Desktop Model

Desktop works as a three-zone system:
- Left rail: AI Insights, Money, Storage.
- Center: Inbox, capture input, filters, recent captures.
- Right rail: Now/Weather, Calendar, Upcoming.

This is good on large screens because the user sees context and work at the same time.

## Why It Breaks on Small Screens

Mobile and small tablet screens cannot keep three zones visible. When we scale or compress everything, cards become cramped, fixed bars collide with content, and settings become too dense.

The correct solution is not more CSS compression. The correct solution is a separate responsive information architecture:
- Desktop: dashboard layout.
- Tablet: focused center with optional panels.
- Mobile: single-task screens with bottom navigation and bottom sheets.

## Recommended Navigation

### Desktop

Keep the current top navigation:
- Nube home
- Inbox
- Collections
- Upgrade
- Help
- Settings/Profile

Keep rails visible only when there is enough width.

### Tablet

Use the same top navigation, but hide side rails.

Add contextual buttons inside Inbox:
- Insights
- Calendar
- Money
- Storage

Each opens a side panel or centered modal.

### Mobile

Use a real bottom navigation with 4 primary areas:
- Inbox
- Collections
- Search/Ask
- Profile

Move these into Profile or menus:
- Settings
- Help
- Upgrade
- Connections
- Plugins
- Data & Privacy
- Billing

## Screen Mapping

### Inbox

Desktop:
- Hero
- Capture input
- quick filters
- recent captures
- left and right rails

Tablet:
- Hero shorter
- Capture input
- quick filters
- recent captures
- rail content behind buttons

Mobile:
- App title
- Capture input first
- compact filter row
- capture cards
- bottom nav

Mobile should not show the full desktop hero. Use a smaller header:
- "Drop it in."
- optional one-line subtitle
- no full rail widgets

### Capture Cards

Desktop cards can show:
- icon
- type
- title
- content preview
- attachments
- tags
- priority
- actions

Mobile cards should show:
- icon/type
- title
- one content line
- maximum two visible tags
- priority on the right
- quick actions: star/delete/menu

Everything else goes inside the detail view.

Voice captures need a dedicated mobile card:
- play button
- title
- progress
- duration
- minimal actions

### Detail Modal

Desktop:
- large modal with all fields visible.

Tablet:
- large sheet/modal, still readable.

Mobile:
- full-screen detail page or bottom sheet.
- fields stacked:
  - title
  - type/date/priority
  - content
  - tags
  - attachments
  - actions

Avoid wide rows and desktop-style forms.

### Collections

Desktop:
- collection grid with custom sizes.

Tablet:
- two-column grid.

Mobile:
- one-column list/grid hybrid.
- collection cards become compact shortcuts.
- editing collection opens full-screen editor.

### Settings

Desktop:
- tabs/cards are fine.

Tablet:
- tabs can remain, but cards should stack.

Mobile:
- Settings must become a menu:
  - Profile
  - Connections
  - Plugins
  - Tags
  - Data & Privacy
  - Billing

Tap one item to open that section. Do not show all settings sections together.

### Insights / Money / Storage

Desktop:
- left rail.

Tablet:
- modal/panel from Inbox.

Mobile:
- not always visible.
- accessible from Inbox via an "Overview" or "Today" sheet.

Money should become a dedicated compact panel:
- income
- expenses
- latest signals

### Calendar / Upcoming

Desktop:
- right rail.

Tablet:
- button opens calendar panel.

Mobile:
- Today/Upcoming screen or sheet.
- calendar should not sit beside Inbox.

## Breakpoint Strategy

Use layout changes, not only font shrinking.

Recommended breakpoints:
- 1440px and up: full desktop dashboard.
- 1240px to 1439px: desktop compact, right rail only or thinner rails.
- 768px to 1239px: tablet layout, no fixed rails.
- 0px to 767px: mobile layout with bottom nav.

Avoid using global zoom for the whole body. It affects fixed elements and creates broken dock behavior. Scale content only inside dedicated layout containers if needed.

## Implementation Plan

1. Create layout mode detection:
   - desktop
   - tablet
   - mobile

2. Split shell components:
   - DesktopShell
   - TabletShell
   - MobileShell

3. Keep data and views shared:
   - captures
   - profile
   - tags
   - settings
   - AI review
   - integrations

4. Create mobile-specific wrappers:
   - MobileInbox
   - MobileCaptureCard
   - MobileSettings
   - MobileCollections
   - MobileDetailSheet

5. Convert rails into panels:
   - InsightsPanel
   - MoneyPanel
   - CalendarPanel
   - StoragePanel

6. Remove fragile CSS hacks:
   - body zoom
   - topbar-as-dock
   - rail compression on small screens

7. Use responsive preview only for QA, not as the source of truth.

## First Practical Step

The next engineering step should be:

Build `MobileShell` and `MobileBottomNav` as real components, then move the current mobile CSS hacks out of the desktop shell.

This will stop the repeated dock/topbar issues and make mobile development predictable.
