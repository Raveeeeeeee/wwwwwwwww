# Facebook Messenger Agenda Bot

## Overview
A Facebook Messenger bot for managing deadlines and activity reminders in a group chat. The bot allows authorized users (PIO and Representative) to add, manage, and extend activity deadlines, with automatic notifications for upcoming and passed deadlines.

## Project Structure
```
├── index.js              # Main bot file with all command handlers
├── package.json          # Node.js dependencies
├── appstate.json         # Facebook session cookies (user must provide)
├── data/
│   ├── activities.json   # Stored activities/deadlines
│   └── subjects.json     # List of subjects
└── .gitignore           # Git ignore rules
```

## Configuration
- **Prefix**: `/`
- **Timezone**: Asia/Manila (Philippine Time)
- **Time Format**: 12-hour (12:00 AM - 11:59 PM)
- **PIO ID**: 100092567839096
- **Representative ID**: 100004919079151

## Available Commands

### For Everyone:
- `/help` - Show commands
- `/activities` - View pending activities
- `/listsub` - View subjects

### For PIO & Representative Only:
- `/addact [Name] [Subject] [Date] [Time]` - Add new activity
- `/removeact [Name]` - Remove an activity
- `/extend [Name] [Date] [Time]` - Extend deadline
- `/addsub [Subject]` - Add new subject
- `/removesub [Subject]` - Remove a subject

## Setup Instructions

### Getting AppState (Required)
1. Use a **secondary Facebook account** (NOT your main account)
2. Install browser extension: 'c3c-fbstate' or similar
3. Login to Facebook in browser
4. Extract cookies and save to `appstate.json`

### Running the Bot
```bash
npm start
```

## Automatic Features
- **Tomorrow Reminder**: At 8 AM, notifies @everyone about deadlines due tomorrow
- **Auto Cleanup**: Activities are removed 1 day after their deadline

## Dependencies
- @dongdev/fca-unofficial - Facebook Chat API
- moment-timezone - Timezone handling
- node-cron - Scheduled tasks

## Recent Changes
- November 2024: Initial bot creation with full feature set

## Important Notes
- This uses an unofficial Facebook API - use at your own risk
- Account restrictions may occur
- Always use a test/secondary account
