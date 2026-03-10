# SQL Seed Data — Migrate Existing JSON Data

Target: `acdc-portal-db.database.windows.net` / `acdc-portal-db`

Execute these INSERT statements **after** running all CREATE TABLE statements from [SQL_CREATE_TABLES.md](SQL_CREATE_TABLES.md).

> **Note:** This file contains the current test/dev data. In production, you would run the CREATE TABLE statements first (empty), then migrate data from the live JSON files via a Node.js migration script. These INSERTs serve as a reference and validation tool.

---

## 1. Events

```sql
INSERT INTO Events (Id, Name, Description, StartDate, EndDate, Location, Status, RegistrationType, RegistrationOpen, IsActive, MinTeamSize, MaxTeamSize, SequenceId, SequenceEnabled, FileCategories, SendWelcomeEmail, SendInterestAcknowledgment, SendJudgeInvitationEmail, SendCommitteeInvitationEmail, TeamWelcomeEmailId, SharepointUrl, CreatedAt, UpdatedAt)
VALUES
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'ACDC 2027', N'My Little Pony', '2027-01-21', '2027-01-23', N'Soria Moria, Oslo', 'registration', 'team', 1, 0, 3, 5, 'd4e7f8a9-1b2c-4d3e-9f4a-5b6c7d8e9f0a', 1, N'["Team Presentation","Final Delivery"]', 1, 1, 1, 1, NULL, N'https://arcticchallenge.sharepoint.com/:f:/s/ACDC2026-Phenix/IgBQUSXQiUcdQrnwJVIXZjQSAQk8Xeizdv4e3ihdTaqzLYY?e=Nsm8pl', '2026-01-30T22:42:39.508Z', '2026-03-08T23:04:01.834Z'),

    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', N'ACDC mid year single have fun!', N'Test of something single', '2026-02-19', '2026-02-21', N'Virtual', 'pre-registration', 'single', 0, 0, 3, 5, NULL, 0, N'[]', 1, 1, 1, 1, NULL, NULL, '2026-02-17T15:12:38.609Z', '2026-02-17T19:00:28.529Z'),

    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', N'ACDC 2028', N'WE now have Pokemon!', '2026-03-03', '2026-03-06', N'Soria Moria, Oslo', 'pre-registration', 'team', 0, 0, 3, 5, '6d4a95e2-4709-412d-bddd-5112aad292e3', 1, N'[]', 1, 1, 1, 1, NULL, NULL, '2026-02-17T15:13:13.169Z', '2026-02-17T23:09:31.317Z');
```

---

## 2. EventHotelDates

```sql
-- ACDC 2027 hotel dates
INSERT INTO EventHotelDates (EventId, HotelDate, DayLabel, DayLabelFull) VALUES
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '2027-01-20', 'Wed', 'Wednesday'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '2027-01-21', 'Thu', 'Thursday'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '2027-01-22', 'Fri', 'Friday'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '2027-01-23', 'Sat', 'Saturday'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', '2027-01-24', 'Sun', 'Sunday');

-- ACDC mid year
INSERT INTO EventHotelDates (EventId, HotelDate, DayLabel, DayLabelFull) VALUES
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', '2026-02-18', 'Wed', 'Wednesday'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', '2026-02-19', 'Thu', 'Thursday'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', '2026-02-20', 'Fri', 'Friday'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', '2026-02-21', 'Sat', 'Saturday'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', '2026-02-22', 'Sun', 'Sunday');

-- ACDC 2028
INSERT INTO EventHotelDates (EventId, HotelDate, DayLabel, DayLabelFull) VALUES
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-02', 'Mon', 'Monday'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-03', 'Tue', 'Tuesday'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-04', 'Wed', 'Wednesday'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-05', 'Thu', 'Thursday'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-06', 'Fri', 'Friday'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', '2026-03-07', 'Sat', 'Saturday');
```

---

## 3. EventDefaultNights

```sql
-- ACDC 2027
INSERT INTO EventDefaultNights (EventId, NightLabel) VALUES
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'thu-fri'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'fri-sat'),
    ('f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'sat-sun');

-- ACDC mid year
INSERT INTO EventDefaultNights (EventId, NightLabel) VALUES
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', 'thu-fri'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', 'fri-sat'),
    ('ed3411d1-dac6-4a6d-b099-2844e11608c4', 'sat-sun');

-- ACDC 2028
INSERT INTO EventDefaultNights (EventId, NightLabel) VALUES
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', 'tue-wed'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', 'wed-thu'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', 'thu-fri'),
    ('a1ffadfa-4a93-40be-9628-5afacb83c7b3', 'fri-sat');
```

---

## 4. Sequences

```sql
INSERT INTO Sequences (Id, Name, Description, CreatedAt, UpdatedAt) VALUES
    ('d4e7f8a9-1b2c-4d3e-9f4a-5b6c7d8e9f0a', N'ACDC - Standard sequence', N'', '2026-02-09T21:35:44.197Z', '2026-02-09T21:35:44.218Z'),
    ('6d4a95e2-4709-412d-bddd-5112aad292e3', N'Sequence for ACDC 2028', N'Email sequence for event: ACDC 2028', '2026-02-17T23:09:31.268Z', '2026-02-17T23:09:31.285Z');
```

---

## 5. Users

```sql
INSERT INTO Users (Id, Email, FirstName, LastName, Phone, Gamertag, Allergies, IsPortalAdmin, ProfileComplete, TeamId, CreatedAt, UpdatedAt) VALUES
    ('fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'thomas.sandsor@pointtaken.no', N'Thomas', N'Sandsør', N'98422465', N'sadf', N'', 1, 1, NULL, '2026-01-26T22:47:16.418Z', '2026-01-30T15:10:23.408Z'),
    ('ef1166e0-8719-4e52-b515-e4881f7ed107', N'sandsor@outlook.com', N'Thomas', N'Sandsør Outlook', N'99999999', N'ghjkl', N'', 0, 1, NULL, '2026-01-28T23:06:05.549Z', '2026-02-25T10:12:06.808Z'),
    ('636f4338-e61d-463a-b2af-43b05b158493', N'sandsor@gmail.com', N'Thomas', N'Gmail Judge', N'98989898', N'', N'', 0, 1, 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6', '2026-01-30T22:53:24.572Z', '2026-02-24T22:38:35.408Z'),
    ('5ae3536c-4d7a-4dd9-9f7d-47c2144a8416', N'sandsor+committee@gmail.com', N'Thomas', N'Committee', N'9842246', N'', N'', 0, 1, NULL, '2026-02-27T11:58:15.218Z', '2026-02-28T21:37:31.871Z'),
    ('c2732a55-6a37-46f7-86b6-9ff2482e569f', N'sandsor+judge@gmail.com', N'Thomas', N'Judge', N'98422465', N'', N'', 0, 1, NULL, '2026-02-28T07:08:00.384Z', '2026-03-01T09:55:41.434Z'),
    ('9d5d6677-b10f-4e00-bae0-5890653d6065', N'sandsor+participant1@gmail.com', N'Thomas', N'Participant 1', N'22222222', N'', N'', 0, 1, '57c36737-9736-4784-b44e-4c1996d46b36', '2026-03-05T17:10:08.307Z', '2026-03-06T13:57:12.424Z'),
    ('7383013f-aaab-4f77-aceb-fb20a290074f', N'sandsor+participant2@gmail.com', N'Thomas', N'Participant 2', N'98444456', N'', N'', 0, 1, NULL, '2026-03-05T17:19:46.779Z', '2026-03-05T17:36:33.020Z');
```

---

## 6. Teams

```sql
INSERT INTO Teams (Id, TeamName, EventId, NumberOfParticipants, AdminUserId, IsSpecialTeam, SpecialTeamType, CreatedAt, UpdatedAt) VALUES
    ('57c36737-9736-4784-b44e-4c1996d46b36', N'Team number 1', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 3, '7383013f-aaab-4f77-aceb-fb20a290074f', 0, NULL, '2026-03-05T17:19:46.779Z', '2026-03-05T17:19:46.779Z');
```

---

## 7. Badges

```sql
INSERT INTO Badges (Id, Name, Description, Category, ClaimType, ImageUrl, Points, CreatedAt, UpdatedAt) VALUES
    ('badge-community-champion', N'Community Champion', N'Goes out of their way to help and encourage other teams.', 'soft', NULL, N'https://acdc.blog/tag/communitychampion/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-dooh', N'Dooh', N'Goes out of their way to create something extraordinary useless or does something really really stupid!', 'soft', NULL, N'https://acdc.blog/tag/dooh/', -10, '2026-01-01T00:00:00.000Z', '2026-02-22T06:41:01.394Z'),
    ('badge-early-delivery', N'Early Delivery', N'First end-to-end working solution or detailed plan of solution delivery. Must be delivered before lunch (Thursday 12:00).', 'soft', NULL, N'https://acdc.blog/tag/earlydelivery/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-happy-camper', N'Happy Camper', N'Using gadgets, costumes or similar to create a really cool camp, and keep extraordinary team spirit throughout the event.', 'soft', NULL, N'https://acdc.blog/tag/team-spirit/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-morning-glory', N'Morning Glory', N'Starting the day before the sun rises.', 'soft', NULL, N'https://acdc.blog/tag/morningglory/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-remarkable-teamspirit', N'Remarkable Teamspirit', N'Keeps an extraordinary good team spirit throughout the day. Snap a picture and post to social media to spread the word.', 'soft', NULL, N'https://acdc.blog/tag/remarkableteamspirit/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-sharing-is-caring', N'Sharing is Caring', N'Code, dataset or API is made available for other teams and you do a sensible contribution (pull request, integration) on a competing teams solution.', 'soft', NULL, N'https://acdc.blog/tag/sharingiscaring/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-thieving-bastards', N'Thieving Bastards', N'Uses several third-party solutions in the delivery, opensource or payable solutions made available by others. Show the importance of leveraging existing tools and APIs.', 'soft', NULL, N'https://acdc.blog/tag/theivingbastard/', 10, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-best-build', N'Best Build', N'Awarded to the best build inside team claim land.', 'low-code', NULL, N'', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-chameleon', N'Chameleon', N'Solution is responsive. Adapts to all devices and screen sizes.', 'low-code', NULL, N'https://acdc.blog/tag/chameleon/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-crawler', N'Crawler', N'Using search in an innovative, useful way. Solve a business problem!', 'low-code', NULL, N'https://acdc.blog/tag/crawler/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-dash-it-out', N'Dash It Out', N'Create great looking dashboards with graphs, KPIs and reports using your preferred data visualization framework. Minimum 4 graphs, gauges or KPIs. Make sure the dashboard shows business-value.', 'low-code', NULL, N'https://acdc.blog/tag/dashitout/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-dataminer', N'Dataminer', N'Uses external data to add business-value to existing data in your solution, or mine after gold in your own data and present it in an excellent way.', 'low-code', NULL, N'https://acdc.blog/tag/dataminer/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-embedding-numbnuts', N'Embedding Numbnuts', N'Integrate with any external physical device.', 'low-code', NULL, N'https://acdc.blog/tag/embeddingnumbuts/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-feature-bombing', N'Feature Bombing', N'Cram as many user features into one screen as you can. Five or more and you might get some points. If you go all aboard and it all makes sense, extra points.', 'low-code', NULL, N'https://acdc.blog/tag/featurebombing/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-glossy-pixels', N'Glossy Pixels', N'Shiny, beautiful, glossy user interfaces would earn this badge. It won''t break on small screens right?', 'low-code', NULL, N'https://acdc.blog/tag/glossypixels/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-go-with-the-flow', N'Go With The Flow', N'Implement workflow to improve business productivity in a solution. Do you have a process that can be automated?', 'low-code', NULL, N'https://acdc.blog/tag/gowiththeflow/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-hipster', N'Hipster', N'Show use of the hippest coolest tech.', 'low-code', NULL, N'https://acdc.blog/tag/hipster/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-nasty-hacker', N'Nasty Hacker', N'Creating super dirty hacks to achieve awesomeness.', 'low-code', NULL, N'https://acdc.blog/tag/nastyhacker/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-plug-n-play', N'Plug N'' Play', N'This is all about Apps. Create an app/plugin for a Microsoft Product (Teams, SharePoint, Dynamics, Office 365, VS Code, Visual Studio etc.). And don''t forget that it has to solve a business need.', 'low-code', NULL, N'https://acdc.blog/tag/plugnplay/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-power-user-love', N'Power User Love', N'Show a good example of how to use your preferred low-code platform combined with pro code customization.', 'low-code', NULL, N'https://acdc.blog/tag/poweruserlove/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-retro', N'Retro Badge', N'Doing something cool with late technologies. It''s all legacy now, baby!', 'low-code', NULL, N'https://acdc.blog/tag/retro/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-show-and-tell', N'Show And Tell', N'Got a great, well thought idea with some cool sketches? Maybe you can get a badge for that.', 'low-code', NULL, N'https://acdc.blog/tag/showandtell/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-stairway-to-heaven', N'Stairway To Heaven', N'Combine at least three different Microsoft cloud APIs and the badge could be yours!', 'low-code', NULL, N'https://acdc.blog/tag/stairwaytoheaven/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-existential-risk', N'The Existential Risk', N'Demonstrate and mitigate AI that shows an existential risk for the world. Does your solution have a conscience? Can it think on its own? Is it smarter than a 5th grader?', 'low-code', NULL, N'https://acdc.blog/tag/theexistentialrisk/', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-acdc-craftsman', N'ACDC Craftsman', N'Practicing development and deployment best-practice. Can only be claimed on day 3 in a single post, where you demonstrate true ACDC craftsmanship.', 'pro-code', NULL, N'https://acdc.blog/tag/acdccraftsman/', 20, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-client-side-salsa', N'Client Side Salsa', N'Showcases well structured, modern client-side solutions with attention to performance, maintainability, and a great user experience.', 'pro-code', NULL, N'https://acdc.blog/tag/clientsidesalsa/', 20, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-power-of-the-shell', N'Power Of The Shell', N'Script the config of your entire solution. Azure infrastructure as code, ARM, PowerShell, CI/CD.', 'pro-code', NULL, N'https://acdc.blog/tag/poweroftheshell/', 20, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-right-now', N'Right Now', N'Doing something collaborative in real-time with socket.io, signalR, WebSocket etc. Don''t repeat yourself! Expecting to see code on this one.', 'pro-code', NULL, N'https://acdc.blog/tag/rightnow/', 20, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-linkmobility', N'Linkmobility', N'Link Mobility offer the latest within mobile communications and offer scalable solutions with great APIs. As one of the largest SMS distributors in the world, you will always be able to reach your customers.', 'sponsor', NULL, N'https://www.arcticclouddeveloperchallenge.net/link-mobility', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-oneflow', N'Oneflow', N'Welcome to the modern age of contract signing. Our solutions and APIs allow document collaboration before seamlessly signing on any device. Bring your contracts to new levels.', 'sponsor', NULL, N'https://www.arcticclouddeveloperchallenge.net/oneflow', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('badge-mscrm-addons', N'mscrm-addons', N'The real cost of manual documents in Dynamics and how to cut it fast with DocumentsCorePack.', 'sponsor', NULL, N'https://www.arcticclouddeveloperchallenge.net/mscrm-addons', 15, '2026-01-01T00:00:00.000Z', NULL),
    ('b2232a7f-b2a1-45ff-90d0-85cfe64ea002', N'Code in the Dark', N'Surprise challenge to se who is better at real code no AI', 'pro-code', 'exclusive', N'', 50, '2026-02-25T22:59:40.099Z', NULL);
```

---

## 8. AllowedEmails

```sql
INSERT INTO AllowedEmails (Email, IsActive, AddedAt, AddedByUserId) VALUES
    (N'sandsor+participant1@gmail.com', 1, '2026-03-01T19:53:09.292Z', NULL),
    (N'sandsor+participant2@gmail.com', 1, '2026-03-04T14:27:49.852Z', NULL);
```

---

## 9. PendingRegistrations

*(Currently empty — no data to insert)*

---

## 10. Participations

```sql
INSERT INTO Participations (Id, UserId, Email, EventId, Roles, TeamId, IsTeamAdmin, HotelNight_WedThu, HotelNight_ThuFri, HotelNight_FriSat, HotelNight_SatSun, HotelPaidBy, ConvertedFrom, ConvertedAt, ConvertedVia, InvitationId, CreatedAt, UpdatedAt)
VALUES
    ('8941ba18-19d4-40cc-a04c-521b340fdf26', '5ae3536c-4d7a-4dd9-9f7d-47c2144a8416', N'sandsor+committee@gmail.com', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'committee', NULL, 0, 0, 1, 1, 1, N'committee', NULL, NULL, NULL, NULL, '2026-02-27T11:58:48.283Z', '2026-02-27T11:59:21.529Z'),

    ('79261bbb-1fb0-4a16-80ad-b162bb8f42e3', 'c2732a55-6a37-46f7-86b6-9ff2482e569f', N'sandsor+judge@gmail.com', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'judge', NULL, 0, 1, 1, 1, 1, N'committee', NULL, NULL, NULL, NULL, '2026-02-28T20:15:09.243Z', '2026-03-01T09:55:41.826Z'),

    ('3aa46f84-9cd9-4b0b-a65c-98eae2c70523', '9d5d6677-b10f-4e00-bae0-5890653d6065', N'sandsor+participant1@gmail.com', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'participant,interest', '57c36737-9736-4784-b44e-4c1996d46b36', 0, 0, 1, 1, 1, NULL, N'interest', '2026-03-05T23:12:49.726Z', N'invitation', 'f64716cb-0dc1-4bf0-b5c2-aef7728102c1', '2026-03-05T17:10:08.307Z', '2026-03-06T13:57:12.806Z'),

    ('6c63d088-e79b-427c-b2b2-3deac6958abb', '7383013f-aaab-4f77-aceb-fb20a290074f', N'sandsor+participant2@gmail.com', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'participant', '57c36737-9736-4784-b44e-4c1996d46b36', 1, 0, 1, 1, 1, NULL, NULL, NULL, NULL, NULL, '2026-03-05T17:19:46.779Z', '2026-03-05T17:36:33.681Z');
```

---

## 11. TeamMemberships

```sql
-- Participant 1's membership in Team number 1
INSERT INTO TeamMemberships (ParticipationId, TeamId, IsAdmin, IsParticipant, JoinedAt) VALUES
    ('3aa46f84-9cd9-4b0b-a65c-98eae2c70523', '57c36737-9736-4784-b44e-4c1996d46b36', 0, 1, '2026-03-05T23:12:49.726Z');

-- Participant 2's membership in Team number 1 (as admin)
INSERT INTO TeamMemberships (ParticipationId, TeamId, IsAdmin, IsParticipant, JoinedAt) VALUES
    ('6c63d088-e79b-427c-b2b2-3deac6958abb', '57c36737-9736-4784-b44e-4c1996d46b36', 1, 1, '2026-03-05T17:19:46.779Z');
```

---

## 12. Invitations

```sql
INSERT INTO Invitations (Id, Email, InviteeFirstName, InviteeLastName, TeamId, TeamName, EventId, Role, InviterId, InviterName, InviterEmail, Message, Status, CreatedAt, ExpiresAt, AcceptedAt, AcceptedBy, CancelledAt)
VALUES
    ('b1e50601-64a2-4931-ab44-fdff77563b1a', N'sandsor@outlook.com', NULL, NULL, '9d7eb536-4dd6-4484-a53a-090fc4092efd', N'Funny Bunny', NULL, NULL, 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'Join our team for the Arctic Cloud Developer Challenge!', 'accepted', '2026-01-28T23:01:43.352Z', '2026-02-04T23:01:43.355Z', '2026-01-28T23:06:45.944Z', 'ef1166e0-8719-4e52-b515-e4881f7ed107', NULL),

    ('5178580f-d147-4076-9ff4-2f026f9a78f6', N'sandsor@outlook.com', NULL, NULL, 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5', N'Committee - ACDC 2027', NULL, NULL, 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as committee for ACDC 2027', 'pending', '2026-01-30T22:43:39.158Z', '2026-02-06T22:43:39.161Z', NULL, NULL, NULL),

    ('ecdc696f-a7af-49e6-84c0-3076c2c73b21', N'sandsor@gmail.com', NULL, NULL, 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6', N'Judges - ACDC 2027', NULL, NULL, 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as judge for ACDC 2027', 'accepted', '2026-01-30T22:43:53.211Z', '2026-02-06T22:43:53.211Z', '2026-01-30T22:53:42.738Z', '636f4338-e61d-463a-b2af-43b05b158493', NULL),

    ('67c91059-7ffb-4cab-918d-77649f2fa70e', N'thomas.sandsor@pointtaken.no', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'judge', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as judge for ACDC 2027', 'cancelled', '2026-02-23T23:14:40.630Z', '2026-03-02T23:14:40.641Z', NULL, NULL, '2026-02-24T11:54:31.270Z'),

    ('8df03278-8890-456f-8ba1-8daa49bbcdcd', N'thomas.sandsor@pointtaken.no', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'judge', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as judge for ACDC 2027', 'cancelled', '2026-02-24T11:54:36.729Z', '2026-03-03T11:54:36.729Z', NULL, NULL, '2026-02-24T14:35:51.882Z'),

    ('119d6c0b-6514-4ea9-8d79-24251d04a262', N'thomas.sandsor@pointtaken.no', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'judge', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as judge for ACDC 2027', 'accepted', '2026-02-24T14:35:57.031Z', '2026-03-03T14:35:57.031Z', '2026-02-24T19:43:26.737Z', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', NULL),

    ('b339b788-861e-48bc-a3a4-04ce6ab68d9a', N'sandsor@gmail.com', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'committee', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve being invited to join as committee for ACDC 2027', 'accepted', '2026-02-24T22:28:31.009Z', '2026-03-03T22:28:31.044Z', '2026-02-24T22:30:02.599Z', '636f4338-e61d-463a-b2af-43b05b158493', NULL),

    ('4024f11e-06d3-48e8-b5b6-8a24209647b0', N'sandsor+committee@gmail.com', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'committee', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as committee for ACDC 2027', 'accepted', '2026-02-27T11:46:27.224Z', '2026-03-06T11:46:27.254Z', '2026-02-27T11:58:48.286Z', '5ae3536c-4d7a-4dd9-9f7d-47c2144a8416', NULL),

    ('d1cfcde5-5e33-4027-b56e-677b06c2d297', N'sandsor+judge@gmail.com', NULL, NULL, NULL, NULL, 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'judge', 'fb87f83c-a7b2-4f10-91c3-2eb396e1b3c6', N'Thomas Sandsør', N'thomas.sandsor@pointtaken.no', N'You''ve been invited to join as judge for ACDC 2027', 'accepted', '2026-02-28T20:14:09.276Z', '2026-03-07T20:14:09.305Z', '2026-02-28T20:15:09.249Z', 'c2732a55-6a37-46f7-86b6-9ff2482e569f', NULL),

    ('f64716cb-0dc1-4bf0-b5c2-aef7728102c1', N'sandsor+participant1@gmail.com', N'Thomas', N'Participant 1', '57c36737-9736-4784-b44e-4c1996d46b36', N'Team number 1', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', NULL, '7383013f-aaab-4f77-aceb-fb20a290074f', N'Thomas Participant 2', N'sandsor+participant2@gmail.com', N'Join our team for the Arctic Cloud Developer Challenge!', 'accepted', '2026-03-05T22:38:30.121Z', '2026-03-12T22:38:30.161Z', '2026-03-05T23:12:49.746Z', '9d5d6677-b10f-4e00-bae0-5890653d6065', NULL);
```

---

## 13. InterestLeads

```sql
INSERT INTO InterestLeads (Id, EventId, Email, FirstName, LastName, VerificationCode, CodeExpiresAt, Verified, VerifiedAt, CreatedAt, UpdatedAt) VALUES
    ('c50c51da-04d4-41a7-9bfa-4f35c635a736', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', N'sandsor+participant1@gmail.com', N'Thomas', N'Participant 1', NULL, NULL, 1, '2026-03-02T10:49:20.974Z', '2026-03-02T10:49:20.974Z', '2026-03-02T10:49:20.974Z');
```

---

## 14. EventBadges

```sql
INSERT INTO EventBadges (Id, EventId, BadgeId, JudgeUserId, IsActive, CreatedAt, UpdatedAt) VALUES
    ('c2c9047a-0286-43e7-adc7-46c86a0a636e', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'badge-community-champion', 'c2732a55-6a37-46f7-86b6-9ff2482e569f', 1, '2026-02-22T18:39:44.427Z', '2026-02-28T07:10:13.803Z');
-- Note: There are ~10 event badges total. Add the rest from event-badges.json when running full migration.
```

---

## 15. BadgeClaims

```sql
INSERT INTO BadgeClaims (Id, EventBadgeId, EventId, BadgeId, TeamId, Status, BlogUrl, Evidence, AssignedToUserId, ClaimedBy, ClaimedAt, DeclineReason, ReviewedBy, ReviewedAt) VALUES
    ('67b57ddb-dff9-4fb0-a02e-f6fe0b8152f2', 'c2c9047a-0286-43e7-adc7-46c86a0a636e', 'f8a3b2c1-4d5e-4f6a-8b9c-0d1e2f3a4b5c', 'badge-community-champion', '57c36737-9736-4784-b44e-4c1996d46b36', 'declined', N'https://vg.no', N'https://vg.no', NULL, '7383013f-aaab-4f77-aceb-fb20a290074f', '2026-03-06T14:42:14.963Z', N'You didn''t link correctly', 'c2732a55-6a37-46f7-86b6-9ff2482e569f', '2026-03-06T22:50:14.504Z');
```

---

## 16–21. Remaining Tables

The remaining tables (`EmailCampaigns`, `EmailDeliveries`, `EmailLog`, `ScheduledRuns`, `ScheduledRunCampaigns`, `SystemEmailConfig`, `InterestQueue`, `SoloQueue`) follow the same pattern. The email-related tables have significant data volume (16+ delivery rows, 5 campaign rows, etc.).

**For the full migration**, a Node.js script should be created that:
1. Reads each JSON file
2. Transforms the data (unnests arrays, maps hotel night keys to columns, etc.)
3. Inserts into the corresponding SQL tables using parameterized queries

This is recommended over hand-writing all INSERT statements, especially for:
- `EmailDeliveries` (16+ rows with various nullable fields)
- `EmailCampaigns` (content contains large HTML with embedded images)
- `SystemEmailConfig` (deeply nested config structure)

---

## Verification Queries

After running the seed data, verify with:

```sql
-- Count rows in each table
SELECT 'Events' AS TableName, COUNT(*) AS RowCount FROM Events
UNION ALL SELECT 'Users', COUNT(*) FROM Users
UNION ALL SELECT 'Teams', COUNT(*) FROM Teams
UNION ALL SELECT 'Participations', COUNT(*) FROM Participations
UNION ALL SELECT 'TeamMemberships', COUNT(*) FROM TeamMemberships
UNION ALL SELECT 'Invitations', COUNT(*) FROM Invitations
UNION ALL SELECT 'InterestLeads', COUNT(*) FROM InterestLeads
UNION ALL SELECT 'Badges', COUNT(*) FROM Badges
UNION ALL SELECT 'EventBadges', COUNT(*) FROM EventBadges
UNION ALL SELECT 'BadgeClaims', COUNT(*) FROM BadgeClaims
UNION ALL SELECT 'Sequences', COUNT(*) FROM Sequences
UNION ALL SELECT 'EmailCampaigns', COUNT(*) FROM EmailCampaigns
UNION ALL SELECT 'AllowedEmails', COUNT(*) FROM AllowedEmails
UNION ALL SELECT 'EventHotelDates', COUNT(*) FROM EventHotelDates
UNION ALL SELECT 'EventDefaultNights', COUNT(*) FROM EventDefaultNights
ORDER BY TableName;
```

### Expected Row Counts

| Table | Expected |
|-------|----------|
| Events | 3 |
| Users | 7 |
| Teams | 1 |
| Participations | 4 |
| TeamMemberships | 2 |
| Invitations | 10 |
| InterestLeads | 1 |
| Badges | 33 |
| EventBadges | ~10 |
| BadgeClaims | 1 |
| Sequences | 2 |
| EmailCampaigns | 5 |
| EmailDeliveries | 16 |
| AllowedEmails | 2 |
| EventHotelDates | 16 |
| EventDefaultNights | 10 |
