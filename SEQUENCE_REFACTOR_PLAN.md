# Sequence Refactor Plan - Move Sequences into Events

## Overview
Moving sequence management from a separate admin section into the Event editor itself, creating a 1:1 relationship between events and sequences.

## Current State
- Sequences managed separately in "Sequences" admin page
- Events reference sequences via `sequenceId` field  
- Can create/copy/duplicate sequences independently
- Multiple events can theoretically share a sequence (though UI prevents this)

## Target State
- Sequences managed within Event editor (new "Sequence" tab)
- 1:1 relationship: each event has 0 or 1 sequence
- Sequences page becomes read-only (view/reference only)
- Can only create sequence from within an event
- Option to copy from another event's sequence when creating

## Implementation Steps

### Phase 1: Add Sequence Tab to Event Editor ✅
- [x] Add "Sequence" tab button next to "Deliveries"
- [x] Add sequence tab panel with two states:
  - No sequence: Empty state with "Create Email Sequence" button
  - Has sequence: Email list with "Add Email" button

### Phase 2: Add Modals and UI Components
- [ ] Add Quill.js CSS/JS to admin-events.html
- [ ] Add modal styles (copy from admin-campaigns.html)
- [ ] Add "Create Sequence" modal with option to copy from another event
- [ ] Add "Edit Email" modal with Quill editor
- [ ] Add sequence email list rendering
- [ ] Add sequence statistics display

### Phase 3: Implement Frontend Logic (admin-events.js)
- [ ] Load event's sequence when switching to Sequence tab
- [ ] Handle "Create Email Sequence" button click
  - Show modal: "Start from scratch" or "Copy from event"
  - If copying: show dropdown of all events that have sequences
  - Create sequence via API, link to current event
- [ ] Handle "Add Email" button click
  - Show email editor modal with Quill
  - Save email to event's sequence
- [ ] Render email list with status badges, reordering, editing
- [ ] Handle email edit/delete/reorder operations
- [ ] Load and display sequence statistics

### Phase 4: Make Sequences Page Read-Only
- [ ] Remove "New Sequence" button from admin-campaigns.html
- [ ] Remove "Duplicate" button from sequence cards
- [ ] Disable editing in sequence detail view
- [ ] Add notice: "Sequences are managed within Events. This page is for reference only."
- [ ] Keep view/read functionality intact

### Phase 5: Backend Changes (Optional)
- [ ] Add validation: prevent creating sequences without event context
- [ ] Add API endpoint for copying sequence from another event
- [ ] Consider: auto-delete orphaned sequences (sequences not linked to any event)

## Files to Modify

### Frontend
1. **src/admin-events.html**
   - Add Quill.js CSS link in `<head>`
   - Add Sequence tab button
   - Add Sequence tab panel  
   - Add modals for create/edit
   - Add Quill.js scripts before closing `</body>`

2. **src/js/admin-events.js**
   - Add sequence management functions
   - Add modal handlers
   - Add Quill editor initialization  
   - Add email CRUD operations
   - Add reorder functionality

3. **src/admin-campaigns.html**
   - Remove "New Sequence" button
   - Add read-only banner
   - Disable duplicate/edit buttons

4. **src/js/admin-campaigns.js**
   - Disable sequence creation/editing
   - Keep view/read functionality

### Backend
5. **api/src/functions/sequences.js** (optional)
   - Add event context validation
   - Add copy-from-event endpoint

## UI Flow

### Creating First Sequence for Event
1. Admin opens event editor
2. Clicks "Sequence" tab
3. Sees empty state: "No Email Sequence Yet"
4. Clicks "Create Email Sequence"
5. Modal appears:
   - Radio: "Start from scratch" (default)
   - Radio: "Copy from another event"
   - If copy: dropdown shows events with sequences
6. Clicks "Create"
7. Sequence created and linked to event
8. Tab updates to show "Sequence Exists" state
9. Can now add emails to sequence

### Adding Email to Sequence
1. In Sequence tab (sequence exists state)
2. Click "Add Email"
3. Modal with Quill editor opens
4. Fill in: Subject, Content (rich text), CTA button (optional), Status (draft/live), Schedule (optional)
5. Click "Save Email"
6. Email added to sequence, appears in list
7. Can edit, delete, or reorder emails

### Viewing Sequences (Read-Only Page)
1. Admin clicks "Sequences" in left menu
2. Page shows all sequences
3. Banner at top: "📖 Sequences are managed within Events. This page is for reference only."
4. Can click sequence to view emails
5. Cannot create, edit, or duplicate
6. Each sequence card shows which event it belongs to

## Data Structure

### Event Object
```json
{
  "id": "event-123",
  "name": "ACDC 2026",
  "sequenceId": "seq-456",  // Existing field, still used
  "teamWelcomeEmailId": "campaign-789",
  ...
}
```

### Sequence Object (unchanged)
```json
{
  "id": "seq-456",
  "name": "ACDC 2026 Interest Follow-up",
  "description": "Automated emails for interest leads",
  "emails": [
    {
      "id": "email-1",
      "order": 1,
      "subject": "Welcome!",
      "body": "<p>Thanks for your interest...</p>",
      "status": "live",
      "scheduledSendTime": "2026-03-01T14:00:00Z"
    }
  ],
  "createdAt": "2026-02-01T10:00:00Z"
}
```

## Benefits of This Approach

1. **Clearer Mental Model**: Sequences live with events, not separate
2. **Prevents Orphans**: Sequences always belong to an event
3. **Easier Workflow**: Edit event and its email sequence in one place
4. **Copy Capability**: Still can reuse/copy sequences from other events
5. **Backward Compatible**: Existing data structure unchanged
6. **Read-Only Fallback**: Old sequences page still exists for reference

## Testing Checklist

- [ ] Create event without sequence, verify empty state
- [ ] Create sequence from scratch for event
- [ ] Create sequence by copying from another event
- [ ] Add email to sequence
- [ ] Edit email in sequence
- [ ] Delete email from sequence
- [ ] Reorder emails in sequence
- [ ] Change email status (draft/live)
- [ ] Schedule email for future send
- [ ] View sequence statistics (recipients)
- [ ] Switch between events, verify correct sequence loads
- [ ] Go to Sequences page, verify read-only state
- [ ] Verify scheduled emails still send correctly
- [ ] Verify team welcome emails still work

## Rollback Plan

If issues arise:
1. Hide Sequence tab from event editor (CSS display: none)
2. Re-enable Sequences page edit buttons
3. All data remains intact (no schema changes)
4. Roll back frontend JS changes

## Timeline Estimate

- **Phase 1**: ✅ Done (30 min)
- **Phase 2**: 1-2 hours (modals, styles, HTML structure)
- **Phase 3**: 2-3 hours (JavaScript logic, Quill integration)
- **Phase 4**: 30 min (disable Sequences page editing)
- **Phase 5**: 1 hour (backend validation - optional)
- **Total**: 5-7 hours

## Current Progress

✅ Phase 1 Complete
- Sequence tab added to event editor HTML
- Tab button and panel structure in place
- Empty state and exists state markup ready

**Next Steps**: Add modals and Quill editor to admin-events.html

---

**Status**: In Progress
**Started**: Feb 15, 2026  
**Target Completion**: Feb 16, 2026
