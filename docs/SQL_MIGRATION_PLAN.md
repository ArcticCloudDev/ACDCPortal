# SQL Migration Plan — JSON to Azure SQL

## Azure SQL Target

| Property | Value |
|----------|-------|
| **Server** | `acdc-portal-db.database.windows.net` |
| **Database** | `acdc-portal-db` |
| **Tier** | GeneralPurpose, Gen5, 2 vCores (Free Tier) |
| **Collation** | `SQL_Latin1_General_CP1_CI_AS` |
| **Free Limit** | Auto-pauses when idle, 32 GB max |
| **Subscription** | ACDC CSP (`5cc4578c-1bf7-4846-9430-7d3995f6eb63`) |
| **Resource Group** | `External_Team_Portal` |
| **Region** | West Europe |
| **Admin** | `admin@acdc.blog` (Entra ID, AAD-only auth) |
| **Current State** | Empty (0 tables) |

---

## JSON → SQL Table Mapping

| # | JSON File | SQL Table | Structure Type |
|---|-----------|-----------|---------------|
| 1 | `events.json` | `Events` | Array → rows |
| 2 | `teams.json` | `Teams` | Array → rows |
| 3 | `users.json` | `Users` | Array → rows |
| 4 | `participations.json` | `Participations` + `TeamMemberships` | Wrapped array → rows + nested array → child table |
| 5 | `invitations.json` | `Invitations` | Wrapped array → rows |
| 6 | `interest-leads.json` | `InterestLeads` | Wrapped array → rows |
| 7 | `allowed-emails.json` | `AllowedEmails` | Array → rows |
| 8 | `pending-registrations.json` | `PendingRegistrations` | Array → rows |
| 9 | `badges.json` | `Badges` | Array → rows |
| 10 | `event-badges.json` | `EventBadges` | Array → rows |
| 11 | `badge-claims.json` | `BadgeClaims` | Array → rows |
| 12 | `sequences.json` | `Sequences` | Wrapped array → rows |
| 13 | `email-campaigns.json` | `EmailCampaigns` | Wrapped array → rows |
| 14 | `email-deliveries.json` | `EmailDeliveries` | Wrapped array → rows |
| 15 | `email-log.json` | `EmailLog` | Wrapped array → rows |
| 16 | `scheduled-runs.json` | `ScheduledRuns` + `ScheduledRunCampaigns` | Wrapped array → rows + nested → child |
| 17 | `system-email-config.json` | `SystemEmailConfig` | Config object → key/value or JSON column |
| 18 | `interest-queue.json` | `InterestQueue` | Wrapped array → rows |
| 19 | `solo-queue.json` | `SoloQueue` | Array → rows |
| 20 | `email-sequences.json` | *(Deprecated — empty, superseded by `sequences.json`)* | — |
| 21 | `sequence-progress.json` | *(Removed — dead code, never written/read)* | — |

---

## Design Decisions

### 1. Nested Arrays → Child Tables
- `participations.teamMemberships[]` → `TeamMemberships` table (FK to `Participations`)
- `participations.hotelNights{}` → Columns on `Participations` (fixed key set: `wed-thu`, `thu-fri`, etc.)
- `events.hotelDates[]` → `EventHotelDates` table (FK to `Events`)
- `events.hotelDefaultNights[]` → `EventDefaultNights` table (FK to `Events`)
- `scheduled-runs.campaigns[]` → `ScheduledRunCampaigns` table (FK to `ScheduledRuns`)

### 2. System Email Config
`system-email-config.json` has a deeply nested, variable structure (templates with eventThemes keyed by eventId, each containing HTML sections). This is best stored as a **JSON column** (`NVARCHAR(MAX)`) rather than being normalized into many tables. It's essentially configuration, not relational data.

### 3. ID Types
- Most IDs are UUID/GUID → `UNIQUEIDENTIFIER`
- Badge IDs use slug format (`badge-community-champion`) → `NVARCHAR(100)`
- Legacy prefix IDs (`camp_xxx`, `del_xxx`) → `NVARCHAR(100)` (but actual data now uses GUIDs)
- User IDs are GUIDs → `UNIQUEIDENTIFIER`

### 4. Hotel Nights as Columns
The `hotelNights` object has a fixed set of possible keys based on event dates. Since we never see more than ~5-6 night options, these are flattened to BIT columns with sanitized names: `HotelNight_MonTue`, `HotelNight_TueWed`, etc.

### 5. Roles Array on Participations
The `roles[]` array (e.g., `["participant", "interest"]`) is a small fixed set. This becomes a comma-separated value in an NVARCHAR column, or a separate `ParticipationRoles` child table. Given the small cardinality (max ~3 roles), a simple NVARCHAR column is pragmatic.

### 6. Email Campaign Content
HTML email content can be very large (especially with embedded base64 images). These go into `NVARCHAR(MAX)` columns.

---

## Execution Order

Tables must be created in dependency order (parent tables first):

1. **Events** (no FK dependencies)
2. **EventHotelDates** (FK → Events)
3. **EventDefaultNights** (FK → Events)
4. **Sequences** (no FK dependencies)
5. **Users** (no FK dependencies)
6. **Teams** (FK → Events)
7. **Badges** (no FK dependencies)
8. **AllowedEmails** (no FK dependencies)
9. **PendingRegistrations** (no FK dependencies)
10. **Participations** (FK → Users, Events)
11. **TeamMemberships** (FK → Participations, Teams)
12. **Invitations** (FK → Events, Teams — nullable)
13. **InterestLeads** (FK → Events)
14. **EventBadges** (FK → Events, Badges, Users)
15. **BadgeClaims** (FK → EventBadges, Events, Badges, Teams, Users)
16. **EmailCampaigns** (FK → Sequences)
17. **EmailDeliveries** (FK → EmailCampaigns)
18. **EmailLog** (FK → EmailCampaigns — nullable)
19. **ScheduledRuns** (no FK dependencies)
20. **ScheduledRunCampaigns** (FK → ScheduledRuns, EmailCampaigns)
21. **SystemEmailConfig** (standalone config table)
22. **InterestQueue** (FK → Events)
23. **SoloQueue** (FK → Events)

---

## Next Steps

See **[SQL_CREATE_TABLES.md](SQL_CREATE_TABLES.md)** for the complete CREATE TABLE statements.
See **[SQL_SEED_DATA.md](SQL_SEED_DATA.md)** for INSERT statements to migrate existing data.
