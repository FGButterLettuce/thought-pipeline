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
const PREFERENCES_FILE = path.join(BASE, 'data', 'preferences.json');

// Ensure dirs
[AUDIO_DIR, RECORDINGS_DIR, path.join(BASE, 'data')].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(express.json());
app.use(express.static(path.join(BASE, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
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
  const seenIds = new Set();
  for (const file of files) {
    const fileTopics = parseScoutFile(path.join(SCOUT_DIR, file));
    for (const topic of fileTopics) {
      if (!seenIds.has(topic.id)) {
        seenIds.add(topic.id);
        topics.push(topic);
      }
    }
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
  const prefs = getPreferences();
  const deletedIds = prefs.deleted || [];
  const scoutTopics = getAllTopics()
    .filter(t => !deletedIds.includes(t.id))
    .map(t => ({ ...t, topicSource: 'scout' }));
  const userTopics = getUserTopics()
    .filter(t => !deletedIds.includes(t.id))
    .map(t => ({ ...t, topicSource: 'user' }));
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

  // Get template from request
  const template = req.body.template || 'default';
  const templatePrompts = {
    'default': '',
    'hot-take': 'Frame this as a bold, slightly controversial opinion that challenges conventional wisdom. Be punchy and memorable.',
    'eli5': 'Explain this concept simply as if to a non-technical executive. Use analogies and avoid jargon.',
    'contrarian': 'Take an unexpected counter-position. What would most people get wrong about this?',
    'story': 'Frame this as a personal anecdote or narrative with a clear beginning, conflict, and lesson.',
    'lessons': 'Focus on actionable takeaways. What should the reader do differently after reading this?'
  };
  const angleInstruction = templatePrompts[template] || '';

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

    // Build system prompt with template angle
    let systemPrompt = 'You are a LinkedIn ghostwriter for a Head of Technology at a fintech startup. Write engaging, authentic LinkedIn posts. Keep it concise (150-250 words), use a conversational but professional tone. Include a hook in the first line. No hashtags unless they add real value.';
    if (angleInstruction) {
      systemPrompt += ' ' + angleInstruction;
    }

    // Generate LinkedIn draft
    const chatPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt
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
    
    // Save draft with template info
    const drafts = getDrafts();
    const draftObj = {
      id: crypto.randomUUID(),
      topicId: topic.id,
      topicTitle: topic.title,
      transcript,
      draft,
      template: template || 'default',
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

// Draft Analytics
app.get('/api/drafts/analytics', (req, res) => {
  const drafts = getDrafts();
  const now = new Date();
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
  
  // Weekly stats
  const thisWeekDrafts = drafts.filter(d => new Date(d.createdAt) >= oneWeekAgo);
  const lastWeekDrafts = drafts.filter(d => {
    const dDate = new Date(d.createdAt);
    return dDate >= twoWeeksAgo && dDate < oneWeekAgo;
  });
  
  // Template usage (extracted from recording history - stored in draft data)
  const templateCounts = {};
  drafts.forEach(d => {
    const template = d.template || 'default';
    templateCounts[template] = (templateCounts[template] || 0) + 1;
  });
  
  // Streak calculation
  const draftsByDay = {};
  drafts.forEach(d => {
    const day = d.createdAt.split('T')[0];
    draftsByDay[day] = (draftsByDay[day] || 0) + 1;
  });
  
  // Calculate current streak
  let streak = 0;
  let checkDate = new Date();
  while (true) {
    const dayStr = checkDate.toISOString().split('T')[0];
    if (draftsByDay[dayStr] || checkDate.toDateString() === now.toDateString()) {
      if (draftsByDay[dayStr]) streak++;
    } else {
      break;
    }
    checkDate.setDate(checkDate.getDate() - 1);
  }
  
  res.json({
    totalDrafts: drafts.length,
    thisWeek: thisWeekDrafts.length,
    lastWeek: lastWeekDrafts.length,
    templateUsage: templateCounts,
    streak: streak,
    draftsByDay: draftsByDay,
    mostProductiveDay: Object.entries(draftsByDay)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null
  });
});

// Draft Versions
const DRAFT_VERSIONS_FILE = path.join(BASE, 'data', 'draft-versions.json');

function getDraftVersions() {
  try { return JSON.parse(fs.readFileSync(DRAFT_VERSIONS_FILE, 'utf-8')); } 
  catch { return {}; }
}

function saveDraftVersions(versions) {
  fs.writeFileSync(DRAFT_VERSIONS_FILE, JSON.stringify(versions, null, 2));
}

app.get('/api/drafts/:id/versions', (req, res) => {
  const versions = getDraftVersions();
  res.json(versions[req.params.id] || []);
});

app.post('/api/drafts/:id/versions', (req, res) => {
  const { draft } = req.body;
  const versions = getDraftVersions();
  if (!versions[req.params.id]) versions[req.params.id] = [];
  
  versions[req.params.id].push({
    draft,
    createdAt: new Date().toISOString(),
    version: versions[req.params.id].length + 1
  });
  
  // Keep only last 20 versions
  if (versions[req.params.id].length > 20) {
    versions[req.params.id] = versions[req.params.id].slice(-20);
  }
  
  saveDraftVersions(versions);
  res.json({ ok: true });
});

// Draft Scheduling
const SCHEDULED_DRAFTS_FILE = path.join(BASE, 'data', 'scheduled-drafts.json');

function getScheduledDrafts() {
  try { return JSON.parse(fs.readFileSync(SCHEDULED_DRAFTS_FILE, 'utf-8')); } 
  catch { return []; }
}

function saveScheduledDrafts(scheduled) {
  fs.writeFileSync(SCHEDULED_DRAFTS_FILE, JSON.stringify(scheduled, null, 2));
}

app.get('/api/drafts/scheduled', (req, res) => {
  res.json(getScheduledDrafts());
});

app.post('/api/drafts/:id/schedule', (req, res) => {
  const { date, time } = req.body; // date: YYYY-MM-DD, time: HH:mm
  const drafts = getDrafts();
  const draft = drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  
  const scheduled = getScheduledDrafts();
  const existingIndex = scheduled.findIndex(s => s.draftId === req.params.id);
  
  const scheduledItem = {
    draftId: req.params.id,
    topicTitle: draft.topicTitle,
    draft: draft.draft,
    scheduledDate: date,
    scheduledTime: time,
    scheduledAt: new Date().toISOString(),
    notified: false
  };
  
  if (existingIndex >= 0) {
    scheduled[existingIndex] = scheduledItem;
  } else {
    scheduled.push(scheduledItem);
  }
  
  saveScheduledDrafts(scheduled);
  res.json({ ok: true, scheduled: scheduledItem });
});

app.delete('/api/drafts/:id/schedule', (req, res) => {
  let scheduled = getScheduledDrafts();
  scheduled = scheduled.filter(s => s.draftId !== req.params.id);
  saveScheduledDrafts(scheduled);
  res.json({ ok: true });
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
  const deletedDraft = drafts.find(d => d.id === req.params.id);
  drafts = drafts.filter(d => d.id !== req.params.id);
  saveDrafts(drafts);
  
  // Also remove from preferences.recorded to fix ghost drafts
  if (deletedDraft) {
    const prefs = getPreferences();
    prefs.recorded = prefs.recorded.filter(id => id !== deletedDraft.topicId);
    savePreferences(prefs);
  }
  
  res.json({ ok: true });
});

// --- Preferences System ---
function getPreferences() {
  try { return JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf-8')); } 
  catch { return { skipped: [], interested: [], recorded: [], deleted: [] }; }
}

function savePreferences(prefs) {
  fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

// Mark topic preference
app.post('/api/topics/:id/preference', (req, res) => {
  const { status } = req.body; // 'skipped', 'interested', 'recorded', 'reset'
  const prefs = getPreferences();
  const topicId = req.params.id;
  
  // Remove from all lists first
  prefs.skipped = prefs.skipped.filter(id => id !== topicId);
  prefs.interested = prefs.interested.filter(id => id !== topicId);
  prefs.recorded = prefs.recorded.filter(id => id !== topicId);
  
  // Add to appropriate list
  if (status === 'skipped') prefs.skipped.push(topicId);
  else if (status === 'interested') prefs.interested.push(topicId);
  else if (status === 'recorded') prefs.recorded.push(topicId);
  
  savePreferences(prefs);
  res.json({ ok: true, status });
});

// Delete topic (adds to deleted list)
app.delete('/api/topics/:id', (req, res) => {
  const prefs = getPreferences();
  const topicId = req.params.id;
  
  // Add to deleted list
  if (!prefs.deleted) prefs.deleted = [];
  if (!prefs.deleted.includes(topicId)) {
    prefs.deleted.push(topicId);
  }
  
  // Also remove from other lists
  prefs.skipped = prefs.skipped.filter(id => id !== topicId);
  prefs.interested = prefs.interested.filter(id => id !== topicId);
  prefs.recorded = prefs.recorded.filter(id => id !== topicId);
  
  savePreferences(prefs);
  res.json({ ok: true, deleted: topicId });
});

// Get filtered topics (for driving mode)
app.get('/api/topics/feed', (req, res) => {
  const prefs = getPreferences();
  const allTopics = [...getAllTopics(), ...getUserTopics()];
  const deletedIds = prefs.deleted || [];
  
  // Filter out skipped and deleted topics
  const feed = allTopics.filter(t => !prefs.skipped.includes(t.id) && !deletedIds.includes(t.id));
  
  // Sort: interested first, then new, then recorded last
  feed.sort((a, b) => {
    const aInterested = prefs.interested.includes(a.id);
    const bInterested = prefs.interested.includes(b.id);
    const aRecorded = prefs.recorded.includes(a.id);
    const bRecorded = prefs.recorded.includes(b.id);
    
    if (aInterested && !bInterested) return -1;
    if (!aInterested && bInterested) return 1;
    if (aRecorded && !bRecorded) return 1;
    if (!aRecorded && bRecorded) return -1;
    return 0;
  });
  
  res.json(feed);
});

// Get preferences
app.get('/api/preferences', (req, res) => {
  res.json(getPreferences());
});

// --- TOPIC CLUSTERING ---
function cosineSimilarity(str1, str2) {
  const words1 = str1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const words2 = str2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  const vocab = new Set([...words1, ...words2]);
  const vec1 = {};
  const vec2 = {};
  
  words1.forEach(w => vec1[w] = (vec1[w] || 0) + 1);
  words2.forEach(w => vec2[w] = (vec2[w] || 0) + 1);
  
  let dot = 0, mag1 = 0, mag2 = 0;
  vocab.forEach(word => {
    const v1 = vec1[word] || 0;
    const v2 = vec2[word] || 0;
    dot += v1 * v2;
    mag1 += v1 * v1;
    mag2 += v2 * v2;
  });
  
  if (mag1 === 0 || mag2 === 0) return 0;
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

app.get('/api/topics/:id/similar', (req, res) => {
  const allTopics = [...getAllTopics(), ...getUserTopics()];
  const target = allTopics.find(t => t.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Topic not found' });
  
  const targetText = `${target.title} ${target.summary} ${target.details || ''}`;
  
  const similarities = allTopics
    .filter(t => t.id !== target.id)
    .map(t => {
      const tText = `${t.title} ${t.summary} ${t.details || ''}`;
      return { topic: t, score: cosineSimilarity(targetText, tText) };
    })
    .filter(s => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  
  res.json(similarities);
});

app.post('/api/topics/merge', async (req, res) => {
  const { topicIds, title } = req.body;
  if (!topicIds || topicIds.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 topics to merge' });
  }
  
  const allTopics = [...getAllTopics(), ...getUserTopics()];
  const topics = topicIds.map(id => allTopics.find(t => t.id === id)).filter(Boolean);
  
  if (topics.length < 2) {
    return res.status(400).json({ error: 'Not enough valid topics found' });
  }
  
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  
  try {
    const chatPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a LinkedIn content strategist. Create a cohesive multi-post thread from the provided topics. The thread should flow naturally from one post to the next, building a narrative arc. Return ONLY valid JSON with this structure: {"title": "Thread title", "posts": [{"post": 1, "content": "First post content", "hook": "Opening hook"}, ...]}. Each post should be 100-200 words.`
        },
        {
          role: 'user',
          content: `Create a LinkedIn thread from these ${topics.length} related topics:\n\n${topics.map((t, i) => `${i+1}. ${t.title}\n${t.summary}\n${t.details || ''}\nLink: ${t.link}`).join('\n\n')}`
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
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const thread = JSON.parse(cleaned);
    
    // Save as a special draft
    const drafts = getDrafts();
    const draftObj = {
      id: crypto.randomUUID(),
      topicId: topicIds.join(','),
      topicTitle: title || thread.title || `Thread: ${topics[0].title}`,
      draft: thread.posts.map(p => `Post ${p.post}:\n${p.content}`).join('\n\n---\n\n'),
      threadData: thread,
      isThread: true,
      mergedTopicIds: topicIds,
      createdAt: new Date().toISOString()
    };
    drafts.unshift(draftObj);
    saveDrafts(drafts);
    
    res.json(draftObj);
  } catch (err) {
    console.error('Thread generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate thread' });
  }
});

// --- BATCH VOICE MODE ---
const BATCH_SESSIONS_FILE = path.join(BASE, 'data', 'batch-sessions.json');

function getBatchSessions() {
  try { return JSON.parse(fs.readFileSync(BATCH_SESSIONS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveBatchSessions(sessions) {
  fs.writeFileSync(BATCH_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

app.post('/api/batch/start', (req, res) => {
  const session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'recording',
    recordings: []
  };
  const sessions = getBatchSessions();
  sessions.push(session);
  saveBatchSessions(sessions);
  res.json(session);
});

app.get('/api/batch/:id', (req, res) => {
  const sessions = getBatchSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.post('/api/batch/:id/recording', upload.single('audio'), async (req, res) => {
  const sessions = getBatchSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  
  const { topicId, topicTitle } = req.body;
  const ext = req.file.mimetype === 'audio/webm' ? 'webm' : 'wav';
  const newPath = `${req.file.path}.${ext}`;
  fs.renameSync(req.file.path, newPath);
  
  session.recordings.push({
    id: crypto.randomUUID(),
    topicId,
    topicTitle,
    audioPath: newPath,
    createdAt: new Date().toISOString()
  });
  saveBatchSessions(sessions);
  
  res.json({ ok: true, recordingId: session.recordings[session.recordings.length - 1].id });
});

app.post('/api/batch/:id/process', async (req, res) => {
  const sessions = getBatchSessions();
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  
  const results = [];
  
  for (const rec of session.recordings) {
    try {
      // Transcribe
      const transcription = execSync(
        `curl -s https://api.openai.com/v1/audio/transcriptions \
          -H "Authorization: Bearer ${OPENAI_KEY}" \
          -F "file=@${rec.audioPath}" \
          -F "model=whisper-1"`,
        { timeout: 60000 }
      );
      const transcript = JSON.parse(transcription.toString()).text;
      
      // Get topic
      const allTopics = [...getAllTopics(), ...getUserTopics()];
      const topic = allTopics.find(t => t.id === rec.topicId);
      
      if (topic) {
        // Generate draft
        const chatPayload = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a LinkedIn ghostwriter for a Head of Technology at a fintech startup. Write engaging, authentic LinkedIn posts. Keep it concise (150-250 words).'
            },
            {
              role: 'user',
              content: `Article: ${topic.title}\n\nSummary: ${topic.summary}\n\nMy thoughts: ${transcript}\n\nWrite a LinkedIn post draft.`
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
          batchSessionId: session.id,
          createdAt: new Date().toISOString()
        };
        drafts.unshift(draftObj);
        saveDrafts(drafts);
        
        results.push({ success: true, topicTitle: topic.title, draftId: draftObj.id });
      } else {
        results.push({ success: false, topicTitle: rec.topicTitle, error: 'Topic not found' });
      }
      
      // Clean up audio file
      try { fs.unlinkSync(rec.audioPath); } catch {}
    } catch (err) {
      results.push({ success: false, topicTitle: rec.topicTitle, error: err.message });
    }
  }
  
  session.status = 'processed';
  session.results = results;
  session.processedAt = new Date().toISOString();
  saveBatchSessions(sessions);
  
  res.json({ session, results });
});

// Start HTTP server (Cloudflare Tunnel handles HTTPS)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Thought Pipeline running at http://0.0.0.0:${PORT}`);
});
