import express from 'express';
import cors from 'cors';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Security headers, CORS, and body limits
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET','POST'] }));
app.use(express.json({ limit: '200kb' }));

// Basic rate limit to deter scraping/abuse
const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 300,                  // requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const COUNTRY_FILES = {
  germany:     'daad_programmes.jsonl',
  netherlands: 'nl_programs.jsonl',
  sweden:      'sweden_rendered_all.jsonl',
  finland:     'studyinfoFin_programmes.jsonl'
};

const SCHOLAR_FILES = {
  main: 'scholarships_pk.jsonl',
  details: 'scholar_details.jsonl'
};

function resolvePrivateFile(fileName) {
  return path.join(__dirname, 'private', 'data', fileName);
}

async function loadJsonl(filePath) {
  const text = await readFile(filePath, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  });
  return out;
}

// helpers similar to your frontend to get a title for filtering
function cleanTitle(s){
  s = String(s||'').trim();
  if(!s) return s;
  const m = s.match(/^(.+?):\s*(.+)$/);
  if(m){
    const A = m[1].trim();
    const B = m[2].trim();
    if(A.toLowerCase().includes(B.toLowerCase())) return A;
  }
  const words = s.split(/\s+/);
  for(let k=Math.min(8, Math.floor(words.length/2)); k>=2; k--){
    const suffix = words.slice(-k).join(' ');
    const prefix = words.slice(0, -k).join(' ');
    if(prefix.toLowerCase().includes(suffix.toLowerCase())){
      return prefix.trim();
    }
  }
  return s;
}
function getTitle(country, p){
  if(country === 'germany'){
    return cleanTitle(p.programme_title || p.title || '');
  } else if(country === 'netherlands'){
    return p.name || p.title || p.programTitle || '';
  } else if(country === 'sweden'){
    return cleanTitle(p.title || p.programme_title || p.header_line || '');
  } else if(country === 'finland'){
    return cleanTitle(p.title || p.detail?.nimi?.en || p.detail?.nimi?.fi || '');
  }
  return '';
}

app.get('/api/courses', async (req, res) => {
  try {
    const country = String(req.query.country || 'germany').toLowerCase();
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || '20'), 10)));

    const fileName = COUNTRY_FILES[country];
    if (!fileName) return res.status(400).json({ error: 'Unsupported country' });

    // Place files at: ./private/data/<fileName>
    const filePath = resolvePrivateFile(fileName);
    const all = await loadJsonl(filePath);

    let filtered = all;
    if (q) {
      filtered = all.filter(p => (getTitle(country, p) || '').toLowerCase().includes(q));
    }

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    res.json({ data, total, page, pageSize, country });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/scholarships', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const country = String(req.query.country || '').trim();
    const level = String(req.query.level || '').trim();
    const deadline = String(req.query.deadline || '').trim(); // YYYY-MM-DD
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || '20'), 10)));

    const mainPath = resolvePrivateFile(SCHOLAR_FILES.main);
    const detailsPath = resolvePrivateFile(SCHOLAR_FILES.details);

    const [main, details] = await Promise.all([
      loadJsonl(mainPath),
      loadJsonl(detailsPath)
    ]);

    const stepsById = new Map();
    for (const d of details) {
      if (!d) continue;
      const did = d.id ?? d.scholarship_id;
      if (did === undefined || did === null) continue;
      const steps = Array.isArray(d.steps)
        ? d.steps
        : (Array.isArray(d.application_steps) ? d.application_steps : []);
      stepsById.set(did, steps);
    }

    let merged = main.map(s => {
      const sid = s.id ?? s.scholarship_id;
      return { ...s, steps: stepsById.get(sid) || [] };
    });

    if (country) {
      const cc = String(country).trim().toLowerCase();
      merged = merged.filter(s => String(s.country || s.country_region || s.countryRegion || '')
        .trim().toLowerCase() === cc);
    }
    if (level) {
      const lvl = String(level).trim();
      merged = merged.filter(s => {
        const levels = s.degree_levels || s.degreeLevels || s.levels;
        if (Array.isArray(levels)) return levels.map(String).includes(lvl);
        if (typeof levels === 'string') return String(levels) === lvl;
        return false;
      });
    }
    if (deadline) {
      const dl = String(deadline);
      merged = merged.filter(s => !s.deadline || String(s.deadline) >= dl);
    }
    if (q) {
      const qq = q.toLowerCase();
      merged = merged.filter(s => {
        const title = String(s.name || s.title || '').toLowerCase();
        const provider = String(s.provider || s.organizer || '').toLowerCase();
        return title.includes(qq) || provider.includes(qq);
      });
    }

    const total = merged.length;
    const start = (page - 1) * pageSize;
    const data = merged.slice(start, start + pageSize);

    res.json({ data, total, page, pageSize });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve static Vite build in production
const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
// If later you switch to a SPA router, uncomment the fallback below:
// app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));

// Centralized error handler (keep responses generic)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});