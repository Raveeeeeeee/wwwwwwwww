const login = require("@dongdev/fca-unofficial");
const fs = require("fs");
const cron = require("node-cron");
const moment = require("moment-timezone");

// Configuration
const PREFIX = "/";
const TIMEZONE = "Asia/Manila";
const PIO_ID = "100092567839096";
const REPRESENTATIVE_ID = "100004919079151";
const ADMINS = [PIO_ID, REPRESENTATIVE_ID];
const AUTO_UNSEND_DELAY = 10 * 60 * 1000; // 10 minutes in milliseconds

// Data file paths
const SUBJECTS_FILE = "./data/subjects.json";
const APPSTATE_FILE = "./appstate.json";
const GROUP_THREADS_FILE = "./data/group_threads.json";
const GROUP_DATA_DIR = "./data/groups";

// Ensure group data directory exists
if (!fs.existsSync(GROUP_DATA_DIR)) {
  fs.mkdirSync(GROUP_DATA_DIR, { recursive: true });
}

// Legacy activities file path (for migration)
const LEGACY_ACTIVITIES_FILE = "./data/activities.json";

// Track groups that have been initialized this session
const initializedGroups = new Set();

// Track legacy data for migration to all groups
let legacyActivitiesCache = null;

function getGroupThreads() {
  const data = loadJSON(GROUP_THREADS_FILE);
  return data ? new Set(data.threads) : new Set();
}

function saveGroupThreads(threads) {
  saveJSON(GROUP_THREADS_FILE, { threads: Array.from(threads) });
}

let groupThreadIDs = getGroupThreads();

// Helper Functions
function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error(`Error loading ${filePath}:`, err.message);
  }
  return null;
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error(`Error saving ${filePath}:`, err.message);
    return false;
  }
}

// Per-group data functions
function getGroupDataPath(threadID) {
  return `${GROUP_DATA_DIR}/${threadID}.json`;
}

function getGroupActivities(threadID) {
  const filePath = getGroupDataPath(threadID);
  const data = loadJSON(filePath);
  if (!data || !data.activities) return [];
  
  // Normalize activities to ensure all notification flags exist
  let needsSave = false;
  const normalizedActivities = data.activities.map(act => {
    // Check if any new flags are missing
    if (act.notifiedNextWeek === undefined || 
        act.notifiedThisWeek === undefined || 
        act.notified2Days === undefined) {
      needsSave = true;
    }
    return {
      ...act,
      notifiedNextWeek: act.notifiedNextWeek || false,
      notifiedThisWeek: act.notifiedThisWeek || false,
      notified2Days: act.notified2Days || false,
      notifiedTomorrow: act.notifiedTomorrow || false,
      notifiedToday: act.notifiedToday || false,
      notified30Min: act.notified30Min || false,
      notifiedEnded: act.notifiedEnded || false,
      ended: act.ended || false
    };
  });
  
  // Persist normalized data back to disk if flags were missing
  if (needsSave) {
    saveGroupActivities(threadID, normalizedActivities);
    console.log(`📦 Normalized activity flags for group ${threadID}`);
  }
  
  return normalizedActivities;
}

function saveGroupActivities(threadID, activities) {
  const filePath = getGroupDataPath(threadID);
  saveJSON(filePath, { activities, lastUpdated: getCurrentTime().toISOString() });
}

function initializeGroupData(threadID, shouldMigrateLegacy = true) {
  const filePath = getGroupDataPath(threadID);
  if (!fs.existsSync(filePath)) {
    // Check if there's legacy data to migrate
    // We cache the legacy data so all groups get the same initial copy
    if (shouldMigrateLegacy && legacyActivitiesCache === null) {
      const legacyData = loadJSON(LEGACY_ACTIVITIES_FILE);
      if (legacyData && legacyData.activities && legacyData.activities.length > 0) {
        legacyActivitiesCache = legacyData.activities;
      } else {
        legacyActivitiesCache = []; // No legacy data
      }
    }
    
    // Migrate legacy data to this group (each group gets its own independent copy)
    if (shouldMigrateLegacy && legacyActivitiesCache && legacyActivitiesCache.length > 0) {
      // Create a deep copy so each group has completely independent data
      // Reset all notification flags and generate new unique IDs
      const migratedActivities = legacyActivitiesCache.map(act => {
        // Deep clone the activity with fresh IDs and reset notification flags
        return {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9), // New unique ID
          name: act.name,
          subject: act.subject,
          deadline: act.deadline,
          time: act.time || null,
          createdBy: act.createdBy,
          createdAt: act.createdAt,
          // Reset all notification flags for this group
          notifiedNextWeek: false,
          notifiedThisWeek: false,
          notified2Days: false,
          notifiedTomorrow: false,
          notifiedToday: false,
          notified30Min: false,
          notifiedEnded: false,
          ended: false,
          // Mark as migrated
          migratedFrom: "legacy",
          migratedAt: getCurrentTime().toISOString()
        };
      });
      saveGroupActivities(threadID, migratedActivities);
      console.log(`📦 Migrated ${migratedActivities.length} legacy activities to group ${threadID}`);
    } else {
      // Create empty activities for new group (when no legacy data exists)
      saveGroupActivities(threadID, []);
      console.log(`📦 Initialized empty data for group ${threadID}`);
    }
  }
  initializedGroups.add(threadID);
}

function getSubjects() {
  const data = loadJSON(SUBJECTS_FILE);
  return data ? data.subjects : [];
}

function saveSubjects(subjects) {
  saveJSON(SUBJECTS_FILE, { subjects });
}

function isAdmin(senderID) {
  return ADMINS.includes(senderID);
}

function getCurrentTime() {
  return moment().tz(TIMEZONE);
}

function formatTime(time) {
  if (!time) return null;
  const parsed = moment(time, ["h:mma", "h:mm a", "HH:mm", "ha", "h a"], true);
  if (!parsed.isValid()) return null;
  return parsed.format("h:mm A");
}

function getCountdown(deadline, hasTime) {
  const now = getCurrentTime();
  // Parse the ISO deadline and convert to Manila timezone
  const deadlineMoment = moment(deadline).tz(TIMEZONE);
  
  // Get start of today and start of deadline day in Manila timezone
  const todayStart = now.clone().startOf('day');
  const deadlineStart = deadlineMoment.clone().startOf('day');
  
  // Check if the deadline is today (same calendar day in Manila timezone)
  const isToday = todayStart.isSame(deadlineStart, 'day');
  
  // For activities without specific time, deadline is end of that day (11:59:59 PM)
  let effectiveDeadline = deadlineMoment.clone();
  if (!hasTime) {
    effectiveDeadline = deadlineMoment.clone().endOf('day');
  }
  
  // Check if deadline has passed
  if (now.isAfter(effectiveDeadline)) {
    if (isToday) {
      return "TODAY (PASSED)";
    }
    return "PASSED";
  }
  
  // If it's today and deadline hasn't passed
  if (isToday) {
    if (hasTime) {
      const duration = moment.duration(deadlineMoment.diff(now));
      const hours = Math.floor(duration.asHours());
      const minutes = duration.minutes();
      
      if (hours > 0) {
        return `${hours}h ${minutes}m left`;
      } else if (minutes > 0) {
        return `${minutes}m left`;
      } else {
        return "< 1m left";
      }
    }
    return "TODAY";
  }
  
  // Check if it's tomorrow
  const tomorrowStart = todayStart.clone().add(1, 'day');
  if (deadlineStart.isSame(tomorrowStart, 'day')) {
    return "TOMORROW";
  }
  
  // Calculate precise time difference
  const duration = moment.duration(effectiveDeadline.diff(now));
  const totalDays = Math.floor(duration.asDays());
  const hours = duration.hours();
  const minutes = duration.minutes();
  
  let parts = [];
  if (totalDays > 0) parts.push(`${totalDays}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (totalDays === 0 && minutes > 0) parts.push(`${minutes}m`);
  
  return parts.length > 0 ? parts.join(" ") + " left" : "< 1m left";
}

function isValidTime(timeStr) {
  if (!timeStr) return true;
  const parsed = moment(timeStr, ["h:mma", "h:mm a", "HH:mm", "ha", "h a"], true);
  return parsed.isValid();
}

function isDateString(str) {
  const datePattern = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  return datePattern.test(str);
}

function findDateIndex(args) {
  for (let i = 0; i < args.length; i++) {
    if (isDateString(args[i])) {
      return i;
    }
  }
  return -1;
}

function findSubjectInArgs(args, subjects) {
  const dateIndex = findDateIndex(args);
  if (dateIndex === -1 || dateIndex < 2) {
    return null;
  }

  const subjectsLower = subjects.map(s => s.toLowerCase());
  let bestMatch = null;
  let bestMatchLength = 0;

  for (let j = dateIndex - 1; j >= 1; j--) {
    const potentialSubject = args.slice(1, j + 1).join(" ").toLowerCase();
    const matchIndex = subjectsLower.indexOf(potentialSubject);
    if (matchIndex !== -1) {
      const matchLength = j;
      if (matchLength > bestMatchLength) {
        bestMatchLength = matchLength;
        bestMatch = {
          activityName: args[0],
          subject: subjects[matchIndex],
          dateIndex: j + 1
        };
      }
    }
  }

  return bestMatch;
}

function parseDate(dateStr) {
  // Parse date in MM/DD/YYYY format with strict Manila timezone
  const formats = ["MM/DD/YYYY", "M/D/YYYY", "MM/D/YYYY", "M/DD/YYYY"];
  const parsed = moment.tz(dateStr, formats, true, TIMEZONE);
  return parsed.isValid() ? parsed : null;
}

function parseDateTime(dateStr, timeStr) {
  const date = parseDate(dateStr);
  if (!date) return null;

  if (timeStr) {
    const time = moment(timeStr, ["h:mma", "h:mm a", "HH:mm", "ha", "h a"], true);
    if (time.isValid()) {
      date.hour(time.hour());
      date.minute(time.minute());
      date.second(0);
      date.millisecond(0);
    }
  } else {
    // If no time specified, set to start of day in Manila timezone
    date.hour(0);
    date.minute(0);
    date.second(0);
    date.millisecond(0);
  }
  return date;
}

function formatDeadline(activity) {
  const date = moment(activity.deadline).tz(TIMEZONE);
  let formatted = date.format("MMMM D, YYYY");
  if (activity.time) {
    formatted += ` at ${activity.time}`;
  }
  return formatted;
}

function getActivityDisplayName(name) {
  return name.replace(/_/g, " ");
}

// Helper function to get ISO week number in Manila timezone
function getWeekNumber(date) {
  const d = moment(date).tz(TIMEZONE);
  return d.isoWeek();
}

// Helper function to get year-week string for comparison (e.g., "2025-W48")
function getYearWeek(date) {
  const d = moment(date).tz(TIMEZONE);
  return `${d.isoWeekYear()}-W${d.isoWeek()}`;
}

// Helper function to format remaining time until deadline (for NEXT WEEK and THIS WEEK reminders)
function formatTimeRemaining(deadline, hasTime) {
  const now = getCurrentTime();
  const deadlineMoment = moment(deadline).tz(TIMEZONE);
  
  // For activities without specific time, deadline is end of that day
  let effectiveDeadline = deadlineMoment.clone();
  if (!hasTime) {
    effectiveDeadline = deadlineMoment.clone().endOf('day');
  }
  
  const duration = moment.duration(effectiveDeadline.diff(now));
  const totalDays = Math.floor(duration.asDays());
  const hours = duration.hours();
  const minutes = duration.minutes();
  
  let parts = [];
  if (totalDays > 0) parts.push(`${totalDays} day${totalDays > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
  if (totalDays === 0 && minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  
  return parts.length > 0 ? parts.join(", ") : "less than a minute";
}

// Check if deadline is in the next week (following Monday to Sunday)
function isDeadlineNextWeek(deadline) {
  const now = getCurrentTime();
  const deadlineMoment = moment(deadline).tz(TIMEZONE);
  
  // Get next Monday (start of next week)
  const nextMonday = now.clone().startOf('isoWeek').add(1, 'week');
  // Get next Sunday (end of next week)
  const nextSunday = nextMonday.clone().endOf('isoWeek');
  
  return deadlineMoment.isBetween(nextMonday, nextSunday, 'day', '[]');
}

// Check if deadline is in the current week (this Monday to this Saturday - excluding Sunday)
function isDeadlineThisWeek(deadline) {
  const now = getCurrentTime();
  const deadlineMoment = moment(deadline).tz(TIMEZONE);
  
  // Get this Monday (start of current week)
  const thisMonday = now.clone().startOf('isoWeek');
  // Get this Saturday (end of week minus Sunday)
  const thisSaturday = thisMonday.clone().add(5, 'days').endOf('day');
  
  return deadlineMoment.isBetween(thisMonday, thisSaturday, 'day', '[]');
}

// Check if activity was created in the current week
function wasCreatedThisWeek(createdAt) {
  const now = getCurrentTime();
  const createdMoment = moment(createdAt).tz(TIMEZONE);
  
  return getYearWeek(now) === getYearWeek(createdMoment);
}

// Check if deadline is 2 days from now
function isDeadlineIn2Days(deadline) {
  const now = getCurrentTime();
  const deadlineMoment = moment(deadline).tz(TIMEZONE);
  
  const twoDaysFromNow = now.clone().add(2, 'days').startOf('day');
  const twoDaysFromNowEnd = twoDaysFromNow.clone().endOf('day');
  
  return deadlineMoment.isBetween(twoDaysFromNow, twoDaysFromNowEnd, 'day', '[]');
}

// Helper function to send a simple message
function sendSimpleMessage(api, threadID, messageBody) {
  return new Promise((resolve) => {
    api.sendMessage(messageBody, threadID, (err, messageInfo) => {
      if (err) {
        console.error(`Failed to send message to ${threadID}:`, err.message);
        resolve(null);
      } else {
        resolve(messageInfo);
      }
    });
  });
}

// Batch addact helper function (returns result instead of sending message)
function executeBatchAddact(args, senderID, threadID) {
  if (args.length < 3) {
    return { success: false, activityName: args[0] || "Unknown", error: "Invalid format" };
  }

  const dateIndex = findDateIndex(args);
  if (dateIndex === -1) {
    return { success: false, activityName: args[0], error: "No valid date" };
  }

  if (dateIndex < 2) {
    return { success: false, activityName: args[0], error: "Missing subject" };
  }

  const subjects = getSubjects();
  const parsed = findSubjectInArgs(args, subjects);

  if (!parsed) {
    const attemptedSubject = args.slice(1, dateIndex).join(" ");
    return { success: false, activityName: args[0], error: `Subject "${attemptedSubject}" not found` };
  }

  const { activityName, subject: subjectMatch, dateIndex: parsedDateIndex } = parsed;
  const dateStr = args[parsedDateIndex];
  const timeStr = args[parsedDateIndex + 1] || null;

  if (!isValidTime(timeStr)) {
    return { success: false, activityName: getActivityDisplayName(activityName), error: "Invalid time" };
  }

  const deadline = parseDateTime(dateStr, timeStr);
  if (!deadline) {
    return { success: false, activityName: getActivityDisplayName(activityName), error: "Invalid date" };
  }

  const activities = getGroupActivities(threadID);
  const exists = activities.find(
    a => a.name.toLowerCase() === activityName.toLowerCase() && 
         a.subject.toLowerCase() === subjectMatch.toLowerCase()
  );

  if (exists) {
    return { success: false, activityName: getActivityDisplayName(activityName), error: "Already exists" };
  }

  const formattedTime = formatTime(timeStr);
  const newActivity = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    name: activityName,
    subject: subjectMatch,
    deadline: deadline.toISOString(),
    time: formattedTime,
    createdBy: senderID,
    createdAt: getCurrentTime().toISOString(),
    // Initialize notification flags
    notifiedNextWeek: false,
    notifiedThisWeek: false,
    notified2Days: false,
    notifiedTomorrow: false,
    notifiedToday: false,
    notified30Min: false,
    notifiedEnded: false,
    ended: false
  };

  activities.push(newActivity);
  saveGroupActivities(threadID, activities);

  return { success: true, activityName: getActivityDisplayName(activityName) };
}

// Command Handlers
const commands = {
  help: {
    description: "Show all available commands",
    adminOnly: false,
    execute: (api, event, args) => {
      const helpMessage = `📋 Bot Commands

Everyone:

${PREFIX}help - Show commands

${PREFIX}activities - View pending activities

${PREFIX}listsub - View subjects

PIO/Representative Only:

${PREFIX}addact [Name] [Subject] [Date] [Time]

${PREFIX}removeact [Name] - Remove activity

${PREFIX}extend [Name] [Date] [Time]

${PREFIX}addsub [Subject]

${PREFIX}removesub [Subject]

${PREFIX}listgroups - View tracked groups

📝 Use _ for spaces in activity names
📅 Date: MM/DD/YYYY | Time: 12hr (e.g. 10:00pm)`;

      api.sendMessage(helpMessage, event.threadID);
    }
  },

  activities: {
    description: "Show all pending activities",
    adminOnly: false,
    execute: (api, event, args) => {
      const threadID = event.threadID;
      
      // Ensure group data is initialized
      if (!initializedGroups.has(threadID)) {
        initializeGroupData(threadID, false);
      }
      
      const activities = getGroupActivities(threadID);
      const subjects = getSubjects();
      const now = getCurrentTime();

      const pendingActivities = activities.filter(act => {
        const deadline = moment(act.deadline).tz(TIMEZONE);
        if (act.time) {
          return now.isBefore(deadline);
        } else {
          // For activities without time, they're valid until end of deadline day
          const endOfDeadlineDay = deadline.clone().endOf("day");
          return now.isBefore(endOfDeadlineDay);
        }
      });

      if (pendingActivities.length === 0) {
        api.sendMessage("📭 No pending activities.", event.threadID);
        return;
      }

      const grouped = {};
      subjects.forEach(sub => { grouped[sub] = []; });
      pendingActivities.forEach(act => {
        if (!grouped[act.subject]) grouped[act.subject] = [];
        grouped[act.subject].push(act);
      });

      let message = "📋 Pending Activities\n";

      for (const subject of subjects) {
        if (grouped[subject] && grouped[subject].length > 0) {
          message += `\n📚 ${subject}\n`;
          grouped[subject].forEach((act, i) => {
            const name = getActivityDisplayName(act.name);
            const deadlineMoment = moment(act.deadline).tz(TIMEZONE);
            const dayName = deadlineMoment.format("dddd");
            const dateStr = deadlineMoment.format("MMM D, YYYY");
            const timeStr = act.time ? ` ${act.time}` : "";
            const countdown = getCountdown(act.deadline, !!act.time);
            message += `- ${name}\n  ${dayName}, ${dateStr}${timeStr}\n  ⏳ ${countdown}\n`;
          });
        }
      }

      const listedSubjects = subjects.map(s => s.toLowerCase());
      const otherActs = pendingActivities.filter(act => !listedSubjects.includes(act.subject.toLowerCase()));
      if (otherActs.length > 0) {
        message += `\n📚 Other\n`;
        otherActs.forEach((act, i) => {
          const name = getActivityDisplayName(act.name);
          const deadlineMoment = moment(act.deadline).tz(TIMEZONE);
          const dayName = deadlineMoment.format("dddd");
          const dateStr = deadlineMoment.format("MMM D, YYYY");
          const timeStr = act.time ? ` ${act.time}` : "";
          const countdown = getCountdown(act.deadline, !!act.time);
          message += `- ${name}\n  ${dayName}, ${dateStr}${timeStr}\n  ⏳ ${countdown}\n`;
        });
      }

      // Send message and schedule auto-unsend after 10 minutes
      api.sendMessage(message.trim(), event.threadID, (err, messageInfo) => {
        if (err) {
          console.error("Failed to send activities message:", err.message);
          return;
        }
        
        // Schedule auto-unsend after 10 minutes
        setTimeout(() => {
          api.unsendMessage(messageInfo.messageID, (unsendErr) => {
            if (unsendErr) {
              console.error("Failed to unsend activities message:", unsendErr.message);
            } else {
              console.log(`✅ Auto-unsent activities message in thread ${event.threadID}`);
            }
          });
        }, AUTO_UNSEND_DELAY);
      });
    }
  },

  addact: {
    description: "Add a new activity",
    adminOnly: true,
    execute: (api, event, args) => {
      const threadID = event.threadID;
      
      // Ensure group data is initialized
      if (!initializedGroups.has(threadID)) {
        initializeGroupData(threadID, false);
      }
      
      if (args.length < 3) {
        api.sendMessage(
          `❌ Invalid format!\n\nUsage: ${PREFIX}addact [Activity_Name] [Subject] [Date] [Time]\n\nExample: ${PREFIX}addact Performance_Task_3 English 10/23/2025 10:00pm\nExample: ${PREFIX}addact Quiz_1 Araling Panlipunan 12/01/2025\n\n💡 Remember: Use underscores (_) for spaces in activity names!`,
          event.threadID
        );
        return;
      }

      const dateIndex = findDateIndex(args);
      if (dateIndex === -1) {
        api.sendMessage(
          `❌ No valid date found!\n\nPlease include a date in MM/DD/YYYY format (e.g., 12/01/2025)\n\nUsage: ${PREFIX}addact [Activity_Name] [Subject] [Date] [Time]\nExample: ${PREFIX}addact Quiz_1 English 12/01/2025 10:00pm`,
          event.threadID
        );
        return;
      }

      if (dateIndex < 2) {
        api.sendMessage(
          `❌ Missing activity name or subject!\n\nUsage: ${PREFIX}addact [Activity_Name] [Subject] [Date] [Time]\nExample: ${PREFIX}addact Quiz_1 English 12/01/2025 10:00pm`,
          event.threadID
        );
        return;
      }

      const subjects = getSubjects();
      const parsed = findSubjectInArgs(args, subjects);

      if (!parsed) {
        const attemptedSubject = args.slice(1, dateIndex).join(" ");
        api.sendMessage(
          `❌ Subject "${attemptedSubject}" not found!\n\nAvailable subjects:\n${subjects.map(s => `• ${s}`).join("\n")}\n\nUse ${PREFIX}addsub to add a new subject.`,
          event.threadID
        );
        return;
      }

      const { activityName, subject: subjectMatch, dateIndex: parsedDateIndex } = parsed;
      const dateStr = args[parsedDateIndex];
      const timeStr = args[parsedDateIndex + 1] || null;

      if (!isValidTime(timeStr)) {
        api.sendMessage(
          `❌ Invalid time format!\n\nUse 12-hour format: e.g., 10:00am, 3:30pm, 11:59pm\nMake sure the time is valid (e.g., not 10:70pm)`,
          event.threadID
        );
        return;
      }

      const deadline = parseDateTime(dateStr, timeStr);
      if (!deadline) {
        api.sendMessage(
          `❌ Invalid date format!\n\nUse: MM/DD/YYYY (e.g., 10/23/2025)\nTime (optional): 12-hour format (e.g., 10:00pm)`,
          event.threadID
        );
        return;
      }

      const activities = getGroupActivities(threadID);
      const exists = activities.find(
        a => a.name.toLowerCase() === activityName.toLowerCase() && 
             a.subject.toLowerCase() === subjectMatch.toLowerCase()
      );

      if (exists) {
        api.sendMessage(
          `❌ Activity "${getActivityDisplayName(activityName)}" already exists for ${subjectMatch}!`,
          event.threadID
        );
        return;
      }

      const formattedTime = formatTime(timeStr);
      const newActivity = {
        id: Date.now().toString(),
        name: activityName,
        subject: subjectMatch,
        deadline: deadline.toISOString(),
        time: formattedTime,
        createdBy: event.senderID,
        createdAt: getCurrentTime().toISOString(),
        // Initialize notification flags
        notifiedNextWeek: false,
        notifiedThisWeek: false,
        notified2Days: false,
        notifiedTomorrow: false,
        notifiedToday: false,
        notified30Min: false,
        notifiedEnded: false,
        ended: false
      };

      activities.push(newActivity);
      saveGroupActivities(threadID, activities);

      const displayName = getActivityDisplayName(activityName);
      const formattedDeadline = formatDeadline(newActivity);

      api.sendMessage(
        `✅ Activity added successfully!\n\n📝 Activity: ${displayName}\n📚 Subject: ${subjectMatch}\n📅 Deadline: ${formattedDeadline}`,
        event.threadID
      );
    }
  },

  extend: {
    description: "Extend activity deadline",
    adminOnly: true,
    execute: (api, event, args) => {
      const threadID = event.threadID;
      
      // Ensure group data is initialized
      if (!initializedGroups.has(threadID)) {
        initializeGroupData(threadID, false);
      }
      
      if (args.length < 2) {
        api.sendMessage(
          `❌ Invalid format!\n\nUsage: ${PREFIX}extend [Activity_Name] [New_Date] [New_Time]\n\nExample: ${PREFIX}extend Performance_Task_3 10/25/2025 11:59pm`,
          event.threadID
        );
        return;
      }

      const activityName = args[0];
      const newDateStr = args[1];
      const newTimeStr = args[2] || null;

      if (!isValidTime(newTimeStr)) {
        api.sendMessage(
          `❌ Invalid time format!\n\nUse 12-hour format: e.g., 10:00am, 3:30pm, 11:59pm\nMake sure the time is valid (e.g., not 10:70pm)`,
          event.threadID
        );
        return;
      }

      const activities = getGroupActivities(threadID);
      const activityIndex = activities.findIndex(
        a => a.name.toLowerCase() === activityName.toLowerCase()
      );

      if (activityIndex === -1) {
        api.sendMessage(
          `❌ Activity "${getActivityDisplayName(activityName)}" not found!`,
          event.threadID
        );
        return;
      }

      const newDeadline = parseDateTime(newDateStr, newTimeStr);
      if (!newDeadline) {
        api.sendMessage(
          `❌ Invalid date format!\n\nUse: MM/DD/YYYY (e.g., 10/25/2025)\nTime (optional): 12-hour format (e.g., 11:59pm)`,
          event.threadID
        );
        return;
      }

      const oldDeadline = formatDeadline(activities[activityIndex]);
      const formattedTime = formatTime(newTimeStr);
      
      activities[activityIndex].deadline = newDeadline.toISOString();
      activities[activityIndex].time = formattedTime;
      activities[activityIndex].extended = true;
      activities[activityIndex].extendedBy = event.senderID;
      activities[activityIndex].extendedAt = getCurrentTime().toISOString();

      saveGroupActivities(threadID, activities);

      const displayName = getActivityDisplayName(activityName);
      const formattedNewDeadline = formatDeadline(activities[activityIndex]);

      api.sendMessage(
        `✅ Deadline extended!\n\n📝 Activity: ${displayName}\n📚 Subject: ${activities[activityIndex].subject}\n📅 Old Deadline: ${oldDeadline}\n📅 New Deadline: ${formattedNewDeadline}`,
        event.threadID
      );
    }
  },

  removeact: {
    description: "Remove an activity",
    adminOnly: true,
    execute: (api, event, args) => {
      const threadID = event.threadID;
      
      // Ensure group data is initialized
      if (!initializedGroups.has(threadID)) {
        initializeGroupData(threadID, false);
      }
      
      if (args.length < 1) {
        api.sendMessage(
          `❌ Please provide the activity name.\n\nUsage: ${PREFIX}removeact [Activity_Name]`,
          event.threadID
        );
        return;
      }

      const activityName = args[0];
      const activities = getGroupActivities(threadID);
      const activityIndex = activities.findIndex(
        a => a.name.toLowerCase() === activityName.toLowerCase()
      );

      if (activityIndex === -1) {
        api.sendMessage(
          `❌ Activity "${getActivityDisplayName(activityName)}" not found.`,
          event.threadID
        );
        return;
      }

      const removed = activities.splice(activityIndex, 1)[0];
      saveGroupActivities(threadID, activities);

      const displayName = getActivityDisplayName(removed.name);
      api.sendMessage(
        `✅ Activity "${displayName}" removed.`,
        event.threadID
      );
    }
  },

  addsub: {
    description: "Add a new subject",
    adminOnly: true,
    execute: (api, event, args) => {
      if (args.length < 1) {
        api.sendMessage(
          `❌ Please provide a subject name!\n\nUsage: ${PREFIX}addsub [Subject_Name]\nExample: ${PREFIX}addsub Research`,
          event.threadID
        );
        return;
      }

      const subjectName = args.join(" ");
      const subjects = getSubjects();

      const exists = subjects.find(
        s => s.toLowerCase() === subjectName.toLowerCase()
      );

      if (exists) {
        api.sendMessage(`❌ Subject "${subjectName}" already exists!`, event.threadID);
        return;
      }

      subjects.push(subjectName);
      saveSubjects(subjects);

      api.sendMessage(`✅ Subject "${subjectName}" added successfully!`, event.threadID);
    }
  },

  removesub: {
    description: "Remove a subject",
    adminOnly: true,
    execute: (api, event, args) => {
      if (args.length < 1) {
        api.sendMessage(
          `❌ Please provide a subject name!\n\nUsage: ${PREFIX}removesub [Subject_Name]\nExample: ${PREFIX}removesub Research`,
          event.threadID
        );
        return;
      }

      const subjectName = args.join(" ");
      const subjects = getSubjects();

      const index = subjects.findIndex(
        s => s.toLowerCase() === subjectName.toLowerCase()
      );

      if (index === -1) {
        api.sendMessage(`❌ Subject "${subjectName}" not found!`, event.threadID);
        return;
      }

      const removed = subjects.splice(index, 1)[0];
      saveSubjects(subjects);

      api.sendMessage(`✅ Subject "${removed}" removed successfully!`, event.threadID);
    }
  },

  listsub: {
    description: "List all subjects",
    adminOnly: false,
    execute: (api, event, args) => {
      const subjects = getSubjects();

      if (subjects.length === 0) {
        api.sendMessage("📭 No subjects registered yet!", event.threadID);
        return;
      }

      let message = "📚 ACTIVE SUBJECTS\n";
      message += "━".repeat(25) + "\n\n";
      subjects.forEach((sub, index) => {
        message += `${index + 1}. ${sub}\n`;
      });
      message += "\n" + "━".repeat(25);

      api.sendMessage(message, event.threadID);
    }
  },

  listgroups: {
    description: "List all tracked groups",
    adminOnly: true,
    execute: (api, event, args) => {
      if (groupThreadIDs.size === 0) {
        api.sendMessage("📭 No groups registered yet!\n\nThe bot will automatically register groups when it receives messages from them.", event.threadID);
        return;
      }

      let message = "📢 TRACKED GROUPS\n";
      message += "━".repeat(25) + "\n\n";
      message += `Total: ${groupThreadIDs.size} group(s)\n\n`;
      
      let index = 1;
      groupThreadIDs.forEach(threadID => {
        const activities = getGroupActivities(threadID);
        message += `${index}. ${threadID}\n   📋 Activities: ${activities.length}\n`;
        index++;
      });
      
      message += "\n" + "━".repeat(25);
      message += "\n\n💡 Each group has its own separate activities.";

      api.sendMessage(message, event.threadID);
    }
  }
};

// Scheduled Tasks
function setupScheduledTasks(api) {
  // Track the last time slot we sent the motivational message (YYYY-MM-DD HH:mm format)
  let lastMotivationalTimeSlot = "";
  
  // Check every minute for deadline reminders
  cron.schedule("* * * * *", async () => {
    if (groupThreadIDs.size === 0) return;

    const now = getCurrentTime();
    const currentMinute = now.minute();
    const currentHour = now.hour();
    const currentDay = now.day(); // 0 = Sunday, 5 = Friday, 6 = Saturday
    const currentTimeSlot = now.format("YYYY-MM-DD HH:mm");
    
    const isFriday = currentDay === 5;
    const isSaturday = currentDay === 6;
    const isSunday = currentDay === 0;
    const isFridayOrSaturday = isFriday || isSaturday;
    
    // Track which groups received reminders this cycle
    const groupsWithReminders = new Set();
    // Track which groups got NEXT WEEK reminders (for motivational message on Fri/Sat)
    const groupsWithNextWeekReminders = new Set();
    
    // Process each group separately and sequentially to avoid race conditions
    for (const threadID of groupThreadIDs) {
      // Ensure group data is initialized
      if (!initializedGroups.has(threadID)) {
        initializeGroupData(threadID, false);
      }
      
      const activities = getGroupActivities(threadID);
      let updated = false;
      
      // Consolidation: Collect all reminders for this group in a single message
      const consolidatedReminders = {
        nextWeek: [],    // Activities due next week
        thisWeek: [],    // Activities due this week
        twoDays: [],     // Activities due in 2 days
        tomorrow: [],    // Activities due tomorrow
        today: [],       // Activities due today
        thirtyMin: [],   // Activities due in 30 minutes
        ended: []        // Activities that have passed deadline
      };

      for (const activity of activities) {
        const deadline = moment(activity.deadline).tz(TIMEZONE);
        const deadlineDay = deadline.day(); // 0 = Sunday
        const todayStart = now.clone().startOf("day");
        const todayEnd = now.clone().endOf("day");
        const tomorrowStart = now.clone().add(1, "day").startOf("day");
        const tomorrowEnd = now.clone().add(1, "day").endOf("day");
        const dayAfterDeadline = deadline.clone().add(1, "day").startOf("day");
        
        const displayName = getActivityDisplayName(activity.name);
        const formattedDeadline = formatDeadline(activity);
        const timeRemaining = formatTimeRemaining(activity.deadline, !!activity.time);
        const deadlineDayName = deadline.format("dddd");

        // NEXT WEEK reminder - Only on Friday (8 AM) or Saturday (8 AM)
        // Deadline must be in the next week (Monday to Sunday)
        if (!activity.notifiedNextWeek && 
            isFridayOrSaturday && 
            currentHour === 8 && currentMinute === 0 &&
            isDeadlineNextWeek(activity.deadline)) {
          
          consolidatedReminders.nextWeek.push({
            name: displayName,
            subject: activity.subject,
            deadline: formattedDeadline,
            dayName: deadlineDayName,
            timeRemaining: timeRemaining
          });
          
          activity.notifiedNextWeek = true;
          updated = true;
        }

        // THIS WEEK reminder - Only on Sunday (8 AM)
        // Deadline must be Monday-Saturday of current week
        // Activity must NOT have been created this week
        // Deadline must NOT be Sunday
        if (!activity.notifiedThisWeek && 
            isSunday && 
            currentHour === 8 && currentMinute === 0 &&
            isDeadlineThisWeek(activity.deadline) &&
            deadlineDay !== 0 && // Deadline is not Sunday
            !wasCreatedThisWeek(activity.createdAt)) {
          
          consolidatedReminders.thisWeek.push({
            name: displayName,
            subject: activity.subject,
            deadline: formattedDeadline,
            dayName: deadlineDayName,
            timeRemaining: timeRemaining
          });
          
          activity.notifiedThisWeek = true;
          updated = true;
        }

        // 2 DAYS reminder - at 8 AM when deadline is in 2 days
        if (!activity.notified2Days && 
            isDeadlineIn2Days(activity.deadline) &&
            currentHour === 8 && currentMinute === 0) {
          
          consolidatedReminders.twoDays.push({
            name: displayName,
            subject: activity.subject,
            deadline: formattedDeadline,
            timeRemaining: timeRemaining
          });
          
          activity.notified2Days = true;
          updated = true;
        }

        // TOMORROW reminder - at 8 AM when deadline is tomorrow
        if (!activity.notifiedTomorrow && 
            deadline.isBetween(tomorrowStart, tomorrowEnd, null, '[]') && 
            currentHour === 8 && currentMinute === 0) {
          
          consolidatedReminders.tomorrow.push({
            name: displayName,
            subject: activity.subject,
            deadline: formattedDeadline,
            timeRemaining: timeRemaining
          });
          
          activity.notifiedTomorrow = true;
          updated = true;
        }

        // TODAY reminder - at 7 AM when deadline is today
        if (!activity.notifiedToday && 
            deadline.isBetween(todayStart, todayEnd, null, '[]') && 
            currentHour === 7 && currentMinute === 0) {
          
          consolidatedReminders.today.push({
            name: displayName,
            subject: activity.subject,
            deadline: formattedDeadline,
            timeRemaining: timeRemaining
          });
          
          activity.notifiedToday = true;
          updated = true;
        }

        // 30 MINUTES reminder - only for activities with specific time
        // Fire when approximately 30 minutes remain (28-31 minute window to account for cron timing)
        // The notified30Min flag ensures this only fires once
        if (!activity.notified30Min && activity.time) {
          const minutesUntilDeadline = deadline.diff(now, "minutes");
          
          // Trigger within 28-31 minute range to handle scheduler drift
          // The notified30Min flag guarantees exactly-once behavior
          if (minutesUntilDeadline >= 28 && minutesUntilDeadline <= 31) {
            consolidatedReminders.thirtyMin.push({
              name: displayName,
              subject: activity.subject,
              time: activity.time,
              minutesLeft: minutesUntilDeadline
            });
            
            activity.notified30Min = true;
            updated = true;
          }
        }

        // DEADLINE MET - activity has passed its deadline
        let shouldEnd = false;
        
        if (activity.time) {
          if (now.isAfter(deadline)) {
            shouldEnd = true;
          }
        } else {
          if (now.isSameOrAfter(dayAfterDeadline)) {
            shouldEnd = true;
          }
        }

        if (!activity.notifiedEnded && shouldEnd) {
          consolidatedReminders.ended.push({
            name: displayName,
            subject: activity.subject
          });
          
          activity.notifiedEnded = true;
          activity.ended = true;
          updated = true;
        }
      }

      // Build and send consolidated message for this group
      let hasReminders = false;
      let messageBody = "";
      
      // NEXT WEEK reminders
      if (consolidatedReminders.nextWeek.length > 0) {
        hasReminders = true;
        groupsWithNextWeekReminders.add(threadID);
        messageBody += "📅 NEXT WEEK DEADLINES 📅\n\n";
        messageBody += "⚠️ The following activities are due NEXT WEEK:\n\n";
        consolidatedReminders.nextWeek.forEach(act => {
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Due: ${act.dayName}, ${act.deadline}\n`;
          messageBody += `⏳ Time remaining: ${act.timeRemaining}\n\n`;
        });
      }
      
      // THIS WEEK reminders
      if (consolidatedReminders.thisWeek.length > 0) {
        hasReminders = true;
        if (messageBody) messageBody += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        messageBody += "📅 THIS WEEK DEADLINES 📅\n\n";
        messageBody += "⚠️ The following activities are due THIS WEEK:\n\n";
        consolidatedReminders.thisWeek.forEach(act => {
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Due: ${act.dayName}, ${act.deadline}\n`;
          messageBody += `⏳ Time remaining: ${act.timeRemaining}\n\n`;
        });
      }
      
      // 2 DAYS reminders
      if (consolidatedReminders.twoDays.length > 0) {
        hasReminders = true;
        if (messageBody) messageBody += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        messageBody += "⚠️ 2 DAYS REMINDER ⚠️\n\n";
        messageBody += "The following activities are due in 2 DAYS:\n\n";
        consolidatedReminders.twoDays.forEach(act => {
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Deadline: ${act.deadline}\n`;
          messageBody += `⏳ Time remaining: ${act.timeRemaining}\n\n`;
        });
      }
      
      // TOMORROW reminders
      if (consolidatedReminders.tomorrow.length > 0) {
        hasReminders = true;
        if (messageBody) messageBody += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        messageBody += "🚨 DEADLINE REMINDER! 🚨\n\n";
        messageBody += "⚠️ The following activities are due TOMORROW:\n\n";
        consolidatedReminders.tomorrow.forEach(act => {
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Deadline: ${act.deadline}\n\n`;
        });
        messageBody += "Please make sure to complete and submit on time!\n\n";
      }
      
      // TODAY reminders
      if (consolidatedReminders.today.length > 0) {
        hasReminders = true;
        if (messageBody) messageBody += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        messageBody += "📢 TODAY'S DEADLINE! 📢\n\n";
        messageBody += "🔴 The following activities are due TODAY:\n\n";
        consolidatedReminders.today.forEach(act => {
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Deadline: ${act.deadline}\n\n`;
        });
        messageBody += "Make sure to submit before the deadline!\n\n";
      }
      
      // 30 MINUTES reminders
      if (consolidatedReminders.thirtyMin.length > 0) {
        hasReminders = true;
        if (messageBody) messageBody += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
        messageBody += "⏰ URGENT REMINDER! ⏰\n\n";
        consolidatedReminders.thirtyMin.forEach(act => {
          messageBody += `🔴 Only ${act.minutesLeft} minutes left!\n\n`;
          messageBody += `📝 ${act.name}\n`;
          messageBody += `📚 Subject: ${act.subject}\n`;
          messageBody += `📅 Deadline: ${act.time}\n\n`;
        });
        messageBody += "Please pass the required output as soon as possible!\n\n";
      }
      
      // Send consolidated reminder message
      if (hasReminders && messageBody) {
        await sendSimpleMessage(api, threadID, messageBody.trim());
        groupsWithReminders.add(threadID);
      }
      
      // DEADLINE MET messages (sent separately as they remove activities)
      if (consolidatedReminders.ended.length > 0) {
        let endedMessage = "📢 DEADLINE MET\n\n";
        consolidatedReminders.ended.forEach(act => {
          endedMessage += `📝 ${act.name}\n`;
          endedMessage += `📚 Subject: ${act.subject}\n\n`;
        });
        endedMessage += "These activities have passed their deadlines and have been removed from the list.";
        
        await sendSimpleMessage(api, threadID, endedMessage.trim());
      }

      if (updated) {
        // Remove ended activities and save
        const activeActivities = activities.filter(a => !a.ended);
        saveGroupActivities(threadID, activeActivities);
      }
    }
    
    // Send motivational message after NEXT WEEK reminders
    // Only send on Friday or Saturday when NEXT WEEK reminders are present
    if (groupsWithNextWeekReminders.size > 0 && 
        isFridayOrSaturday && 
        lastMotivationalTimeSlot !== currentTimeSlot) {
      lastMotivationalTimeSlot = currentTimeSlot;
      
      // Wait a moment for all reminders to be sent, then send motivational message
      setTimeout(async () => {
        for (const threadID of groupsWithNextWeekReminders) {
          await sendSimpleMessage(api, threadID, "Kumilos kilos kana wag tatamad-tamad 😇😇");
        }
      }, 3000); // Wait 3 seconds after reminders
    }
  });

  console.log("✅ Scheduled tasks initialized");
  console.log(`📢 Tracking ${groupThreadIDs.size} group(s) for reminders`);
}

// Scan all groups and initialize their data on startup
function scanAndInitializeGroups(api) {
  console.log("🔍 Scanning groups and initializing data...");
  
  // Get current thread list to find all groups the bot is in
  api.getThreadList(100, null, ["INBOX"], (err, threads) => {
    if (err) {
      console.error("Failed to get thread list:", err.message);
      return;
    }
    
    let groupCount = 0;
    
    threads.forEach(thread => {
      if (thread.isGroup && thread.threadID) {
        // Add to tracked groups if not already tracked
        if (!groupThreadIDs.has(thread.threadID)) {
          groupThreadIDs.add(thread.threadID);
          console.log(`📢 Found group: ${thread.name || thread.threadID}`);
        }
        
        // Initialize group data (all groups get legacy migration if available)
        initializeGroupData(thread.threadID, true);
        groupCount++;
      }
    });
    
    // Save updated group threads
    saveGroupThreads(groupThreadIDs);
    console.log(`✅ Initialized ${groupCount} groups`);
  });
}

// Main Bot Login
function startBot() {
  const appState = loadJSON(APPSTATE_FILE);

  if (!appState || appState.length === 0) {
    console.log("⚠️ No appstate found!");
    console.log("Please add your Facebook appstate to appstate.json");
    console.log("\nTo get your appstate:");
    console.log("1. Install a browser extension like 'c3c-fbstate' or 'EditThisCookie'");
    console.log("2. Login to Facebook in your browser");
    console.log("3. Extract cookies and save them to appstate.json");
    console.log("\n⚠️ WARNING: Use a secondary/test account, NOT your main account!");
    console.log("Using unofficial APIs may result in account restrictions.");
    return;
  }

  console.log("🔄 Logging in...");

  login({ appState }, (err, api) => {
    if (err) {
      console.error("❌ Login failed:", err);
      return;
    }

    console.log("✅ Logged in successfully!");
    console.log(`🤖 Bot is now running with prefix: ${PREFIX}`);
    console.log(`⏰ Timezone: ${TIMEZONE} (Philippine Time)`);

    // Set options
    api.setOptions({
      listenEvents: true,
      selfListen: false
    });

    // Save updated appstate
    fs.writeFileSync(APPSTATE_FILE, JSON.stringify(api.getAppState(), null, 2));

    // Scan and initialize all groups
    scanAndInitializeGroups(api);

    // Setup scheduled tasks
    setupScheduledTasks(api);

    const botID = api.getCurrentUserID();

    // Listen for messages
    api.listenMqtt((err, event) => {
      if (err) {
        console.error("Listen error:", err);
        return;
      }

      // Track ALL group thread IDs for notifications and initialize data
      if (event.isGroup && event.threadID) {
        const isNewGroup = !groupThreadIDs.has(event.threadID);
        if (isNewGroup) {
          groupThreadIDs.add(event.threadID);
          saveGroupThreads(groupThreadIDs);
          initializeGroupData(event.threadID, false); // New groups don't get legacy migration
          console.log(`📢 New group registered: ${event.threadID} (Total: ${groupThreadIDs.size} groups)`);
        } else if (!initializedGroups.has(event.threadID)) {
          // Existing group but not initialized this session
          initializeGroupData(event.threadID, false);
        }
      }

      // Handle bot being added to a group
      if (event.type === "event" && event.logMessageType === "log:subscribe") {
        const addedParticipants = event.logMessageData.addedParticipants || [];
        const botWasAdded = addedParticipants.some(p => p.userFbId === botID);
        
        if (botWasAdded && event.threadID) {
          // Add this group to the tracked list and initialize data
          if (!groupThreadIDs.has(event.threadID)) {
            groupThreadIDs.add(event.threadID);
            saveGroupThreads(groupThreadIDs);
            initializeGroupData(event.threadID, false);
            console.log(`📢 Bot added to new group: ${event.threadID} (Total: ${groupThreadIDs.size} groups)`);
          }
          
          api.changeNickname("Task Scheduler", event.threadID, botID, (err) => {
            if (err) {
              console.error("Failed to set nickname:", err);
            } else {
              console.log(`✅ Nickname set to "Task Scheduler" in group ${event.threadID}`);
            }
          });
        }
      }

      // Only process message events
      if (event.type !== "message" || !event.body) return;

      const body = event.body.trim();

      // Check if message contains any commands
      if (!body.includes(PREFIX)) return;

      // Split message by newlines to support batch commands
      const lines = body.split(/\n/).map(line => line.trim()).filter(line => line.startsWith(PREFIX));

      if (lines.length === 0) return;

      // Process multiple commands (batch mode)
      if (lines.length > 1) {
        let successCount = 0;
        let failCount = 0;
        let results = [];

        for (const line of lines) {
          const args = line.slice(PREFIX.length).split(/\s+/);
          const commandName = args.shift().toLowerCase();
          const command = commands[commandName];

          if (!command) {
            failCount++;
            results.push(`❌ ${args[0] || commandName} - Unknown command`);
            continue;
          }

          if (command.adminOnly && !isAdmin(event.senderID)) {
            failCount++;
            results.push(`❌ ${args[0] || commandName} - Admin only`);
            continue;
          }

          try {
            // For batch mode, we need to capture results instead of sending individual messages
            if (commandName === "addact") {
              const batchResult = executeBatchAddact(args, event.senderID, event.threadID);
              if (batchResult.success) {
                successCount++;
                results.push(`✅ ${batchResult.activityName} - Added`);
              } else {
                failCount++;
                results.push(`❌ ${batchResult.activityName || args[0]} - ${batchResult.error}`);
              }
            } else {
              // For non-addact commands in batch, execute normally
              command.execute(api, event, args);
              successCount++;
            }
          } catch (error) {
            console.error(`Error executing ${commandName}:`, error);
            failCount++;
            results.push(`❌ ${args[0] || commandName} - Error`);
          }
        }

        // Send batch summary
        let summary = `📋 Batch Command Results\n`;
        summary += `━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        summary += results.join("\n");
        summary += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        summary += `✅ Success: ${successCount} | ❌ Failed: ${failCount}`;

        api.sendMessage(summary, event.threadID);
        return;
      }

      // Single command mode (original behavior)
      const args = body.slice(PREFIX.length).split(/\s+/);
      const commandName = args.shift().toLowerCase();

      // Find and execute command
      const command = commands[commandName];

      if (!command) {
        api.sendMessage(
          `❌ Unknown command: ${PREFIX}${commandName}\n\nType ${PREFIX}help for available commands.`,
          event.threadID
        );
        return;
      }

      // Check admin permission
      if (command.adminOnly && !isAdmin(event.senderID)) {
        api.sendMessage(
          "❌ Sorry, this command is only available for PIO and Representative!",
          event.threadID
        );
        return;
      }

      // Execute command
      try {
        command.execute(api, event, args);
      } catch (error) {
        console.error(`Error executing ${commandName}:`, error);
        api.sendMessage(
          "❌ An error occurred while executing this command. Please try again.",
          event.threadID
        );
      }
    });
  });
}

// Start the bot
console.log("🚀 Facebook Messenger Agenda Bot");
console.log("================================");
startBot();
