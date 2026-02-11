const express = require('express');
const multer = require('multer');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = path.resolve(__dirname, '..');
const SCOUT_DIR = '/home/niranjan/.openclaw/workspace/scout';
const AUDIO_DIR = path.join(BASE, 'audio');
const RECORDINGS_DIR = path.join(BASE, 'recordings');
const DRAFTS_FILE = path.join(BASE, 'data', 'drafts.json');
const USER_TOPICS_FILE = path.join(BASE, 'data', 'user-topics.json');

// Ensure dirs
[AUDIO_DIR, RECORDINGS_DIR, path.join(BASE, 'data')].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(express.json());
app.use(express.static(path.join(BASE, 'public')));
app.use('/audio', express.static(AUDIO_DIR));
app.use('/recordings', express.static(RECORDINGS_DIR));

const upload = multer({ dest: RECORDINGS_DIR });

// --- Parse scout markdown files ---
function parseScoutFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const topics = [];
  const sections = content.split(/\n## \d+\.\s+/);
  
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const titleMatch = section.match(/^\*\*(.+?)\*\*/);
    const linkMatch = section.match(/\*\*Link:\*\*\s*\[.*?\]\((.*?)\)/);
    const postWorthyMatch = section.match(/\*\*Post-worthy\?\*\*\s*(.*)/);
    
    // Get the body text (everything between title and Link:)
    const lines = section.split('\n');
    let summary = '';
    let details = '';
    let inWhyMatters = false;
    
    for (const line of lines) {
      if (line.startsWith('**Link:') || line.startsWith('**Post-worthy')) continue;
      if (line.match(/^\*\*Why it matters:\*\*/)) {
        inWhyMatters = true;
        details = line.replace(/^\*\*Why it matters:\*\*\s*/, '');
        continue;
      }
      if (!inWhyMatters && !line.match(/^\*\*/) && line.trim()) {
        summary += line.trim() + ' ';
      }
    }
    
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, '') : `Topic ${i}`;
    
    topics.push({
      id: crypto.createHash('md5').update(title).digest('hex').slice(0, 8),
      index: i,
      title: title.trim(),
      summary: summary.trim(),
      details: details.trim(),
      link: linkMatch ? linkMatch[1] : '',
      postWorthy: postWorthyMatch ? postWorthyMatch[1].trim() : '',
      source: path.basename(filePath, '.md')
    });
  }
  
  return topics;
}

function getAllTopics() {
  if (!fs.existsSync(SCOUT_DIR)) return [];
  const files = fs.readdirSync(SCOUT_DIR).filter(f => f.endsWith('.md')).sort().reverse();
  const topics = [];
  for (const file of files) {
    topics.push(...parseScoutFile(path.join(SCOUT_DIR, file)));
  }
  return topics;
}

function getUserTopics() {
  try { return JSON.parse(fs.readFileSync(USER_TOPICS_FILE, 'utf-8')); } catch { return []; }
}

function saveUserTopics(topics) {
  fs.writeFileSync(USER_TOPICS_FILE, JSON.stringify(topics, null, 2));
}

function getDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8')); } catch { return []; }
}

function saveDrafts(drafts) {
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2));
}

// --- API Routes ---

app.get('/api/topics', (req, res) => {
  const scoutTopics = getAllTopics().map(t => ({ ...t, topicSource: 'scout' }));
  const userTopics = getUserTopics().map(t => ({ ...t, topicSource: 'user' }));
  res.json([...userTopics, ...scoutTopics]);
});

// User-submitted topics
app.get('/api/topics/user', (req, res) => {
  res.json(getUserTopics());
});

app.post('/api/topics/suggest', upload.single('audio'), async (req, res) => {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  let topicIdea = '';

  try {
    // If voice note, transcribe first
    if (req.file) {
      const ext = req.file.mimetype === 'audio/webm' ? 'webm' : 'wav';
      const newPath = `${req.file.path}.${ext}`;
      fs.renameSync(req.file.path, newPath);

      const transcription = execSync(
        `curl -s https://api.openai.com/v1/audio/transcriptions \
          -H "Authorization: Bearer ${OPENAI_KEY}" \
          -F "file=@${newPath}" \
          -F "model=whisper-1"`,
        { timeout: 60000 }
      );
      topicIdea = JSON.parse(transcription.toString()).text;
    } else if (req.body && req.body.text) {
      topicIdea = req.body.text;
    } else {
      return res.status(400).json({ error: 'Provide text or audio' });
    }

    // Research the topic via OpenAI
    const chatPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a research assistant. Given a topic idea, research it thoroughly and return a JSON object with these fields:
- "title": a concise, engaging title
- "summary": 2-3 sentence overview of the topic
- "details": why this matters, different angles, key insights (2-3 sentences)
- "link": a relevant URL for further reading (real, well-known source)
- "postWorthy": your assessment of whether this is worth posting about and why (1 sentence)

Return ONLY valid JSON, no markdown fences.`
        },
        {
          role: 'user',
          content: `Research this topic idea: ${topicIdea}`
        }
      ]
    });

    const chatResult = execSync(
      `curl -s https://api.openai.com/v1/chat/completions \
        -H "Authorization: Bearer ${OPENAI_KEY}" \
        -H "Content-Type: application/json" \
        -d '${chatPayload.replace(/'/g, "'\\''")}'`,
      { timeout: 60000 }
    );

    const content = JSON.parse(chatResult.toString()).choices[0].message.content;
    // Strip markdown fences if present
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const researched = JSON.parse(cleaned);

    const topicId = crypto.createHash('md5').update(researched.title + Date.now()).digest('hex').slice(0, 8);

    const newTopic = {
      id: topicId,
      title: researched.title,
      summary: researched.summary,
      details: researched.details,
      link: researched.link || '',
      postWorthy: researched.postWorthy || '',
      topicSource: 'user',
      createdAt: new Date().toISOString()
    };

    // Save
    const userTopics = getUserTopics();
    userTopics.unshift(newTopic);
    saveUserTopics(userTopics);

    // Generate TTS
    const text = `${newTopic.title}. ${newTopic.summary} ${newTopic.details}`;
    const audioFile = `${topicId}.mp3`;
    const audioPath = path.join(AUDIO_DIR, audioFile);
    
    // Write text to temp file to avoid shell escaping issues
    const tmpFile = path.join('/tmp', `tts-${topicId}.txt`);
    fs.writeFileSync(tmpFile, text);
    
    exec(`edge-tts -f "${tmpFile}" --write-media "${audioPath}" --voice en-US-GuyNeural`, (err) => {
      fs.unlinkSync(tmpFile);
      if (err) console.error('TTS error for user topic:', err.message);
    });

    res.json(newTopic);
  } catch (err) {
    console.error('Topic suggestion error:', err.message);
    res.status(500).json({ error: 'Failed to research topic' });
  }
});

// Generate TTS audio for a topic
app.post('/api/tts/:topicId', (req, res) => {
  const topics = [...getAllTopics(), ...getUserTopics()];
  const topic = topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  
  const audioFile = `${topic.id}.mp3`;
  const audioPath = path.join(AUDIO_DIR, audioFile);
  
  if (fs.existsSync(audioPath)) {
    return res.json({ url: `/audio/${audioFile}` });
  }
  
  const text = `${topic.title}. ${topic.summary} ${topic.details}`;
  
  // Write text to temp file to avoid shell escaping issues
  const tmpFile = path.join('/tmp', `tts-${topic.id}.txt`);
  fs.writeFileSync(tmpFile, text);
  
  exec(`edge-tts -f "${tmpFile}" --write-media "${audioPath}" --voice en-US-GuyNeural`, (err) => {
    fs.unlinkSync(tmpFile); // Clean up temp file
    if (err) {
      console.error('TTS error:', err.message);
      return res.status(500).json({ error: 'TTS generation failed' });
    }
    res.json({ url: `/audio/${audioFile}` });
  });
});

// Upload voice recording
app.post('/api/record/:topicId', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  
  const topics = [...getAllTopics(), ...getUserTopics()];
  const topic = topics.find(t => t.id === req.params.topicId);
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  
  // Rename file with proper extension
  const ext = req.file.mimetype === 'audio/webm' ? 'webm' : 'wav';
  const newPath = `${req.file.path}.${ext}`;
  fs.renameSync(req.file.path, newPath);
  
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  
  try {
    // Transcribe with Whisper
    const transcription = execSync(
      `curl -s https://api.openai.com/v1/audio/transcriptions \
        -H "Authorization: Bearer ${OPENAI_KEY}" \
        -F "file=@${newPath}" \
        -F "model=whisper-1"`,
      { timeout: 60000 }
    );
    const transcript = JSON.parse(transcription.toString()).text;
    
    // Generate LinkedIn draft
    const chatPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a LinkedIn ghostwriter for a Head of Technology at a fintech startup. Write engaging, authentic LinkedIn posts. Keep it concise (150-250 words), use a conversational but professional tone. Include a hook in the first line. No hashtags unless they add real value. The user will provide an article summary and their voice note thoughts — combine both into a polished draft.'
        },
        {
          role: 'user',
          content: `Article: ${topic.title}\n\nSummary: ${topic.summary}\n\nWhy it matters: ${topic.details}\n\nLink: ${topic.link}\n\nMy thoughts (voice note): ${transcript}\n\nWrite a LinkedIn post draft combining the article info with my personal take.`
        }
      ]
    });
    
    const chatResult = execSync(
      `curl -s https://api.openai.com/v1/chat/completions \
        -H "Authorization: Bearer ${OPENAI_KEY}" \
        -H "Content-Type: application/json" \
        -d '${chatPayload.replace(/'/g, "'\\''")}'`,
      { timeout: 60000 }
    );
    
    const draft = JSON.parse(chatResult.toString()).choices[0].message.content;
    
    // Save draft
    const drafts = getDrafts();
    const draftObj = {
      id: crypto.randomUUID(),
      topicId: topic.id,
      topicTitle: topic.title,
      transcript,
      draft,
      createdAt: new Date().toISOString()
    };
    drafts.unshift(draftObj);
    saveDrafts(drafts);
    
    res.json(draftObj);
  } catch (err) {
    console.error('Draft generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

// Drafts CRUD
app.get('/api/drafts', (req, res) => res.json(getDrafts()));

app.put('/api/drafts/:id', (req, res) => {
  const drafts = getDrafts();
  const idx = drafts.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  drafts[idx].draft = req.body.draft;
  saveDrafts(drafts);
  res.json(drafts[idx]);
});

app.delete('/api/drafts/:id', (req, res) => {
  let drafts = getDrafts();
  drafts = drafts.filter(d => d.id !== req.params.id);
  saveDrafts(drafts);
  res.json({ ok: true });
});

// Start HTTP server (Cloudflare Tunnel handles HTTPS)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Thought Pipeline running at http://0.0.0.0:${PORT}`);
});
