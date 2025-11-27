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

// Data file paths
const ACTIVITIES_FILE = "./data/activities.json";
const SUBJECTS_FILE = "./data/subjects.json";
const APPSTATE_FILE = "./appstate.json";

// Thread ID for the group (will be set when bot receives first message from group)
let groupThreadID = null;

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

function getActivities() {
  const data = loadJSON(ACTIVITIES_FILE);
  return data ? data.activities : [];
}

function saveActivities(activities) {
  saveJSON(ACTIVITIES_FILE, { activities });
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
  const deadlineMoment = moment.tz(deadline, TIMEZONE);
  
  if (now.isSameOrAfter(deadlineMoment)) {
    return "PASSED";
  }
  
  const duration = moment.duration(deadlineMoment.diff(now));
  const days = Math.floor(duration.asDays());
  const hours = duration.hours();
  const minutes = duration.minutes();
  
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (hasTime && minutes > 0) parts.push(`${minutes}m`);
  
  if (parts.length === 0) {
    if (hasTime) {
      return "< 1m left";
    } else {
      return "Due today";
    }
  }
  
  return parts.join(" ") + " left";
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
  // Parse date in MM/DD/YYYY format
  const formats = ["MM/DD/YYYY", "M/D/YYYY", "MM/D/YYYY", "M/DD/YYYY"];
  const parsed = moment.tz(dateStr, formats, TIMEZONE);
  return parsed.isValid() ? parsed : null;
}

function parseDateTime(dateStr, timeStr) {
  const date = parseDate(dateStr);
  if (!date) return null;

  if (timeStr) {
    const time = moment(timeStr, ["h:mma", "h:mm a", "HH:mm", "ha", "h a"]);
    if (time.isValid()) {
      date.hour(time.hour());
      date.minute(time.minute());
    }
  }
  return date;
}

function formatDeadline(activity) {
  const date = moment.tz(activity.deadline, TIMEZONE);
  let formatted = date.format("MMMM D, YYYY");
  if (activity.time) {
    formatted += ` at ${activity.time}`;
  }
  return formatted;
}

function getActivityDisplayName(name) {
  return name.replace(/_/g, " ");
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

📝 Use _ for spaces in activity names
📅 Date: MM/DD/YYYY | Time: 12hr (e.g. 10:00pm)`;

      api.sendMessage(helpMessage, event.threadID);
    }
  },

  activities: {
    description: "Show all pending activities",
    adminOnly: false,
    execute: (api, event, args) => {
      const activities = getActivities();
      const subjects = getSubjects();
      const now = getCurrentTime();

      const pendingActivities = activities.filter(act => {
        const deadline = moment.tz(act.deadline, TIMEZONE);
        if (act.time) {
          return now.isBefore(deadline);
        } else {
          const dayAfterDeadline = deadline.clone().add(1, "day").startOf("day");
          return now.isBefore(dayAfterDeadline);
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
            const deadlineMoment = moment.tz(act.deadline, TIMEZONE);
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
          const deadlineMoment = moment.tz(act.deadline, TIMEZONE);
          const dayName = deadlineMoment.format("dddd");
          const dateStr = deadlineMoment.format("MMM D, YYYY");
          const timeStr = act.time ? ` ${act.time}` : "";
          const countdown = getCountdown(act.deadline, !!act.time);
          message += `- ${name}\n  ${dayName}, ${dateStr}${timeStr}\n  ⏳ ${countdown}\n`;
        });
      }

      api.sendMessage(message.trim(), event.threadID);
    }
  },

  addact: {
    description: "Add a new activity",
    adminOnly: true,
    execute: (api, event, args) => {
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

      const activities = getActivities();
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
        createdAt: getCurrentTime().toISOString()
      };

      activities.push(newActivity);
      saveActivities(activities);

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

      const activities = getActivities();
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

      saveActivities(activities);

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
      if (args.length < 1) {
        api.sendMessage(
          `❌ Please provide the activity name.\n\nUsage: ${PREFIX}removeact [Activity_Name]`,
          event.threadID
        );
        return;
      }

      const activityName = args[0];
      const activities = getActivities();
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
      saveActivities(activities);

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
  }
};

// Scheduled Tasks
function setupScheduledTasks(api) {
  // Check every minute for deadline reminders
  cron.schedule("* * * * *", () => {
    if (!groupThreadID) return;

    const now = getCurrentTime();
    const activities = getActivities();
    let updated = false;

    activities.forEach(activity => {
      const deadline = moment.tz(activity.deadline, TIMEZONE);
      const tomorrow = now.clone().add(1, "day").startOf("day");
      const dayAfterDeadline = deadline.clone().add(1, "day").startOf("day");

      // Check if deadline is tomorrow (notify at 8 AM)
      if (!activity.notifiedTomorrow && 
          deadline.isSame(tomorrow, "day") && 
          now.hour() === 8 && now.minute() === 0) {
        
        const displayName = getActivityDisplayName(activity.name);
        const formattedDeadline = formatDeadline(activity);
        
        const message = {
          body: `🚨 DEADLINE REMINDER! 🚨\n\n@everyone\n\n⚠️ The following activity is due TOMORROW:\n\n📝 Activity: ${displayName}\n📚 Subject: ${activity.subject}\n📅 Deadline: ${formattedDeadline}\n\nPlease make sure to complete and submit on time!`,
          mentions: [{ tag: "@everyone", id: groupThreadID }]
        };
        
        api.sendMessage(message, groupThreadID);
        activity.notifiedTomorrow = true;
        updated = true;
      }

      // Check if deadline is 30 minutes away (only for activities with specific time)
      if (!activity.notified30Min && activity.time) {
        const minutesUntilDeadline = deadline.diff(now, "minutes");
        
        if (minutesUntilDeadline <= 30 && minutesUntilDeadline > 0) {
          const displayName = getActivityDisplayName(activity.name);
          
          const message = {
            body: `⏰ URGENT REMINDER! ⏰\n\n@everyone\n\n🔴 Only ${minutesUntilDeadline} minutes left!\n\n📝 Activity: ${displayName}\n📚 Subject: ${activity.subject}\n📅 Deadline: ${activity.time}\n\nPlease pass the required output as soon as possible!`,
            mentions: [{ tag: "@everyone", id: groupThreadID }]
          };
          
          api.sendMessage(message, groupThreadID);
          activity.notified30Min = true;
          updated = true;
        }
      }

      // Check if activity should be removed
      // If time provided: remove after time deadline passed
      // If no time: remove the day after deadline date
      let shouldEnd = false;
      
      if (activity.time) {
        // Has specific time - end when deadline time has passed
        if (now.isSameOrAfter(deadline)) {
          shouldEnd = true;
        }
      } else {
        // No specific time - end the day after deadline
        if (now.isSameOrAfter(dayAfterDeadline)) {
          shouldEnd = true;
        }
      }

      if (!activity.notifiedEnded && shouldEnd) {
        const displayName = getActivityDisplayName(activity.name);
        
        api.sendMessage(
          `📢 DEADLINE MET\n\n📝 Activity: ${displayName}\n📚 Subject: ${activity.subject}\n\nThis activity has now passed its deadline and has been removed from the list.`,
          groupThreadID
        );
        
        activity.notifiedEnded = true;
        activity.ended = true;
        updated = true;
      }
    });

    if (updated) {
      // Remove ended activities
      const activeActivities = activities.filter(a => !a.ended);
      saveActivities(activeActivities);
    }
  });

  console.log("✅ Scheduled tasks initialized");
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
      selfListen: false,
      logLevel: "silent"
    });

    // Save updated appstate
    fs.writeFileSync(APPSTATE_FILE, JSON.stringify(api.getAppState(), null, 2));

    // Setup scheduled tasks
    setupScheduledTasks(api);

    const botID = api.getCurrentUserID();

    // Listen for messages
    api.listenMqtt((err, event) => {
      if (err) {
        console.error("Listen error:", err);
        return;
      }

      // Store group thread ID for notifications
      if (event.isGroup && event.threadID) {
        groupThreadID = event.threadID;
      }

      // Handle bot being added to a group
      if (event.type === "event" && event.logMessageType === "log:subscribe") {
        const addedParticipants = event.logMessageData.addedParticipants || [];
        const botWasAdded = addedParticipants.some(p => p.userFbId === botID);
        
        if (botWasAdded && event.threadID) {
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

      // Check if message starts with prefix
      if (!body.startsWith(PREFIX)) return;

      // Parse command and arguments
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
