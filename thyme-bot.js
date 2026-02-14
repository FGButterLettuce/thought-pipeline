// Thyme Bot - Telegram bot for time management
// Runs as a separate process to handle interactive messages

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const BOT_TOKEN = process.env.THYME_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('THYME_BOT_TOKEN not set in .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const USER_ID = '1709443757'; // Niranjan's Telegram ID

console.log('🌿 Thyme is awake and watching...');

// Handle /start
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  bot.sendMessage(USER_ID, 
    `🌿 Hello! I'm Thyme, your time management companion.\n\n` +
    `I can help you:\n` +
    `• Plan your day and calculate travel times\n` +
    `• Send LEAVE NOW reminders\n` +
    `• Create calendar events\n` +
    `• Manage your schedule\n\n` +
    `Try:\n` +
    `• "Plan my afternoon"\n` +
    `• "I need to be at Dubai Mall by 3 PM"\n` +
    `• "Remind me to leave in 30 minutes"\n` +
    `• "What's my schedule today?"`
  );
});

// Handle /help
bot.onText(/\/help/, (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  bot.sendMessage(USER_ID,
    `🌿 *Thyme Commands:*\n\n` +
    `*/plan* - Get today's schedule overview\n` +
    `*/leave [time] [location]* - Set a departure reminder\n` +
    `*/event [title] at [time]* - Create a calendar event\n` +
    `*/travel [from] to [to]* - Calculate travel time\n` +
    `*/remind [what] in [time]* - Set a reminder\n\n` +
    `Or just chat naturally: "I need to be at the airport by 6 PM"`,
    { parse_mode: 'Markdown' }
  );
});

// Handle /plan
bot.onText(/\/plan/, async (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  bot.sendMessage(USER_ID, '🌿 Checking your schedule...');
  // This will be handled by the isolated agent
});

// Handle natural language messages
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  if (msg.text?.startsWith('/')) return; // Skip commands
  
  const text = msg.text?.toLowerCase() || '';
  
  // Check for travel/time planning requests
  if (text.includes('need to be at') || text.includes('going to') || text.includes('travel to')) {
    bot.sendMessage(USER_ID, 
      `🌿 Got it. Let me calculate the best time to leave...\n\n` +
      `(This will be connected to calendar + maps API)`,
      { reply_to_message_id: msg.message_id }
    );
    return;
  }
  
  // Check for reminder requests
  if (text.includes('remind me') || text.includes('reminder')) {
    bot.sendMessage(USER_ID,
      `🌿 I'll remind you. Setting that up now...`,
      { reply_to_message_id: msg.message_id }
    );
    return;
  }
  
  // Check for planning requests
  if (text.includes('plan') || text.includes('schedule')) {
    bot.sendMessage(USER_ID,
      `🌿 Let me check your calendar and plan this out...`,
      { reply_to_message_id: msg.message_id }
    );
    return;
  }
  
  // Default response
  bot.sendMessage(USER_ID,
    `🌿 I'm listening! You said: "${msg.text}"\n\n` +
    `Try:\n` +
    `• "I need to be at [place] by [time]"\n` +
    `• "Remind me to [task] in [time]"\n` +
    `• "/plan" for your schedule`,
    { reply_to_message_id: msg.message_id }
  );
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Thyme polling error:', error);
});

console.log('🌿 Thyme bot is running and listening for messages...');