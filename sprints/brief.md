# Brief — GSC Data Integrations (Mobile Usability, Core Web Vitals, Sitemaps, Links, Enhancements, Manual Actions)

## Product Overview

Extend GscDataPanel with 6 new Google Search Console data sources as tabs, integrated into the existing SitePage dashboard. All data fetched from Google's APIs, stored in Postgres, and displayed with modern SaaS UX (pagination, filtering, sorting, consistent styling). Single-user owner workflow (Dhiren) with potential team handoff later.

**Deploy:** localhost + existing D:/Acentecom/seo-automation hosting  
**Stack:** TypeScript, React, Express, Postgres (established)  
**Surface:** UI (new tabs in GscDataPanel)  
**Dangerous actions:** None (read-only GSC data)

## Core Elements (make-or-break)

1. **Mobile Usability Issues** — paginated table of issues grouped by type (viewport, clickable elements, font size, etc.) with affected URL counts
2. **Core Web Vitals** — per-URL metrics (LCP, FID, CLS) with color-coded status (good/needs-improvement/poor) and sortable table
3. **Sitemaps** — submission status per sitemap (submitted count, indexed count, error count) with error detail view
4. **Links** — top linking sites table + top linked pages table, both sortable by frequency
5. **Enhancements** — structured data issues grouped by type (breadcrumbs, product, FAQ, etc.) with affected page counts
6. **Manual Actions** — security/spam action status (if any), clear display of "None detected" if clean

## Highest-Leverage Features (ranked, FULL list)

1. Mobile Usability Issues tab ← drives dev priority (quick wins for mobile traffic)
2. Core Web Vitals tab ← signals to Google ranking factors
3. Sitemaps tab ← sitemap health indicator
4. Links tab ← backlink profile visibility
5. Enhancements tab ← structured data health
6. Manual Actions tab ← security/spam monitoring
7. Combined export (all 6 as CSV) ← team handoff deliverable
8. Date-range filters per tab ← historical tracking (Phase 5 feature)

## Full Feature Inventory

**MVP (Phase 2):**
- Mobile Usability schema + sync + API route + tab UI
- Core Web Vitals schema + sync + API route + tab UI
- Sitemaps schema + sync + API route + tab UI
- Links schema + sync + API route + tab UI
- Enhancements schema + sync + API route + tab UI
- Manual Actions schema + sync + API route + tab UI
- Pagination + sorting + basic filtering per tab
- Consistent SaaS styling (match existing GSC tabs)

**Phase 5 (post-MVP):**
- Date-range filters per tab
- Advanced filtering (e.g., issues by severity)
- Combined CSV export
- Auto-sync schedule (daily)
- Alerting (Slack notify on new security issues)

## MVP Carve-out

All 6 data sources live and functional by end of Phase 2. No partial implementations. Each tab:
- Fetches from Google API (quota-permitting)
- Stores in Postgres
- Serves via API route with pagination
- Renders as sortable/filterable table
- Matches GscDataPanel visual design

## MVP Acceptance Criteria

✅ All 6 tabs render in browser with real data from atmhtml5games property  
✅ Pagination works (50/100/250/500 per-page selector)  
✅ Sorting by key columns (issues by count, URLs by frequency, etc.)  
✅ No data deletion (existing GSC data preserved)  
✅ Production build passes (`npm run build`)  
✅ TypeCheck clean (`npx tsc --noEmit`)  
✅ Consistent SaaS UX (spacing, fonts, colors, depth/elevation)  
✅ Mobile-friendly layout (responsive)

---

**Assumptions (using defaults — revise if wrong):**

| Category | Assumption |
|---|---|
| Multi-user | Single user (you); no permission model needed for MVP |
| Empty state | "No data yet. Hit Sync to fetch from Google Search Console." |
| Loading state | Shimmer per existing GscDataPanel pattern |
| Error state | Toast + retry button |
| Search/filter | Exact-match text search + column sorting |
| Mobile | Responsive: stacked columns at <768px width |
| Audit log | None (single-user, read-only data) |

**SIGN-OFF:** Does this brief match what you need? Any revisions before Phase 1?
