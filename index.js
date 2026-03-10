const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
  res.json({ status: 'ClipPrompt backend en ligne' });
});

app.post('/upload', upload.single('video'), async (req, res) => {
  try {
    const filePath = req.file.path;
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const transcript = await whisperRes.json();

    // FIX 1 : valeurs par défaut si Whisper ne retourne rien
    res.json({ 
      success: true, 
      transcript: transcript.text || '',
      segments: transcript.segments || [],
      filename: req.file.filename
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/analyze', async (req, res) => {
  try {
    const { transcript, segments, userPrompt } = req.body;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Tu es un monteur vidéo. Réponds UNIQUEMENT avec du JSON brut, sans markdown, sans backticks, sans texte avant ou après.

Transcription : ${transcript || 'pas de transcription'}
Segments : ${JSON.stringify(segments || [])}
Demande : ${userPrompt}

Format JSON obligatoire :
{"segments_to_keep":[{"start":0,"end":30}],"message":"explication courte"}`
        }]
      })
    });

    const claudeData = await claudeRes.json();

    // FIX 2 : strip markdown avant de parser
    const rawText = claudeData.content[0].text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(rawText);
    res.json(parsed);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/cut', (req, res) => {
  const { filename, segments_to_keep } = req.body;
  const inputPath = path.join('uploads', filename);
  const outputPath = path.join('outputs', `${Date.now()}_final.mp4`);

  if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');

  if (segments_to_keep.length === 1) {
    const seg = segments_to_keep[0];
    const cmd = `ffmpeg -i ${inputPath} -ss ${seg.start} -to ${seg.end} -c copy ${outputPath}`;
    exec(cmd, (error) => {
      if (error) return res.status(500).json({ error: error.message });
      res.json({ success: true, outputFile: path.basename(outputPath) });
    });
    return;
  }

  const filterParts = segments_to_keep.map((seg, i) => 
    `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
  );
  const concatInputs = segments_to_keep.map((_, i) => `[v${i}][a${i}]`).join('');
  const filterComplex = `${filterParts.join(';')};${concatInputs}concat=n=${segments_to_keep.length}:v=1:a=1[outv][outa]`;
  const cmd = `ffmpeg -i ${inputPath} -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" ${outputPath}`;

  exec(cmd, (error) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, outputFile: path.basename(outputPath) });
  });
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join('outputs', req.params.filename);
  res.download(filePath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ClipPrompt backend sur port ${PORT}`));
