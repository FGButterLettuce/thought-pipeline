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

// Forward non-command messages to OpenClaw agent
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== USER_ID) return;
  if (msg.text?.startsWith('/')) return; // Commands handled separately
  
  const text = msg.text;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  
  // Send immediate acknowledgment
  bot.sendMessage(USER_ID, '🌿 Let me think about that...', { reply_to_message_id: messageId });
  
  // Spawn Thyme agent to handle the response (async)
  const { exec } = require('child_process');
  const sanitizedText = text.replace(/'/g, "'\\''");
  const sanitizedToken = BOT_TOKEN.replace(/'/g, "'\\''");
  
  // The agent will generate a response and then call Telegram API directly
  const agentTask = `
You are Thyme, Niranjan's time management AI companion. 
Read your persona from /home/niranjan/.openclaw/workspace/agents/thyme.md.

Niranjan just messaged you: "${sanitizedText}"

Respond helpfully and concisely. Address him directly as "Niranjan".

After generating your response, you MUST send it to Telegram by running:
curl -s -X POST "https://api.telegram.org/bot${sanitizedToken}/sendMessage" \\
  -d "chat_id=${chatId}" \\
  -d "text=<YOUR_RESPONSE_HERE>" \\
  -d "reply_to_message_id=${messageId}"

Replace <YOUR_RESPONSE_HERE> with your actual response text (URL encoded if needed).
`;
  
  exec(
    `openclaw sessions_spawn --label "thyme-interactive" --task '${agentTask.replace(/'/g, "'\\''")}' --agentId main --timeoutSeconds 60`,
    (err) => {
      if (err) console.error('Thyme spawn error:', err.message);
    }
  );
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Thyme polling error:', error);
});

console.log('🌿 Thyme bot is running and listening for messages...');