# Email Sequence System

## Data Model

### Sequences (email-sequences.json)
Groups of sequential emails for an event. Can be copied between years.

```json
{
  "sequences": [
    {
      "id": "seq_xxx",
      "name": "ACDC 2027 Pre-Registration",
      "eventId": "acdc-2027-xxx",
      "description": "Sequence for people who register interest",
      "status": "active",  // active, paused, archived
      "createdAt": "2026-01-31T...",
      "campaigns": [
        "camp_ml2vbsi537rchc",  // Campaign IDs in order
        "camp_ml2vd17ifdrhl3"
      ]
    }
  ]
}
```

### Campaigns (email-campaigns.json)
Individual emails. Now belong to a sequence.

```json
{
  "campaigns": [
    {
      "id": "camp_xxx",
      "sequenceId": "seq_xxx",  // NEW: belongs to a sequence
      "eventId": "acdc-2027-xxx",
      "subject": "Welcome!",
      "content": "<p>...</p>",
      "ctaUrl": null,
      "ctaText": null,
      "type": "sequence",
      "sequenceOrder": 1,  // Position within sequence
      "createdAt": "2026-01-31T..."
    }
  ]
}
```

### Sequence Progress (sequence-progress.json)
Tracks who has entered each sequence and their progress.

```json
{
  "progress": [
    {
      "id": "prog_xxx",
      "sequenceId": "seq_xxx",
      "email": "user@example.com",
      "userId": "user_xxx",  // null for interest leads
      "leadId": "lead_xxx",  // null for registered users
      "currentStep": 2,  // Which email they're on (1-indexed)
      "status": "active",  // active, paused, completed, converted
      "startedAt": "2026-02-01T...",
      "lastSentAt": "2026-02-05T...",
      "convertedAt": null,  // When they became a participant
      "completedAt": null
    }
  ]
}
```

## Features

1. **Grouping**: Sequences group multiple campaigns together
2. **Copy-able**: Can copy entire sequences between events/years
3. **Progress Tracking**: Know exactly who got what email and when
4. **Conversion Detection**: When interest lead becomes participant, mark as "converted" and stop sending
5. **UI**: Show sequence groups with recipient list and progress

## Conversion Flow

1. Interest lead registers → enters sequence (status: "active")
2. Gets email 1 → currentStep: 1, lastSentAt updated
3. Gets email 2 → currentStep: 2, lastSentAt updated
4. Lead creates account + joins team → status: "converted", convertedAt set
5. No more emails sent from this sequence

## Migration Needed

Need to:
1. Create sequences from existing campaigns
2. Update campaign records with sequenceId
3. Create progress records from deliveries
4. Update sending logic to check sequence progress
