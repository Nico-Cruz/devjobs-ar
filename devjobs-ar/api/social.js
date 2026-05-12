// api/social.js — Vercel Serverless Function
// Busca posts de LinkedIn y X via Google Custom Search API

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBV5kSOuP-OC1VOH1MBQFmDVt2oXkO4w-0';
const GOOGLE_CX = process.env.GOOGLE_CX || 'c5328d13e20ba4413';
const CSE_BASE = 'https://www.googleapis.com/customsearch/v1';

// Keywords laborales en español e inglés
const QUERIES = [
  'site:linkedin.com/posts "buscamos" "desarrollador" Argentina',
  'site:linkedin.com/posts "estamos buscando" "developer" Argentina',
  'site:linkedin.com/posts "hiring" "developer" Argentina',
  'site:linkedin.com/posts "buscamos" "programador" Argentina',
  'site:x.com "buscamos desarrollador" Argentina',
  'site:x.com "hiring developer" Argentina remoto',
  'site:x.com "estamos en búsqueda" developer Argentina',
];

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 15 * 60 * 1000; // 15 minutos — cuidar el límite de 100 queries/día

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ source: 'cache', jobs: cache.data, total: cache.data.length });
  }

  try {
    const results = [];

    // Ejecutar queries en paralelo (máx 3 simultáneas para no quemar el límite)
    const chunks = chunkArray(QUERIES, 3);

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map(q => searchGoogle(q))
      );
      settled.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          results.push(...r.value);
        }
      });
    }

    // Deduplicar por URL
    const seen = new Set();
    const unique = results.filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    // Ordenar — los más recientes primero (Google no da fecha exacta, usamos orden de resultado)
    cache = { data: unique, timestamp: now };

    return res.json({ source: 'live', jobs: unique, total: unique.length });

  } catch (err) {
    console.error('Google CSE error:', err);
    return res.status(500).json({ error: 'Error fetching social posts', details: err.message });
  }
}

async function searchGoogle(query) {
  const params = new URLSearchParams({
    key: GOOGLE_API_KEY,
    cx: GOOGLE_CX,
    q: query,
    dateRestrict: 'd3',   // últimos 3 días
    num: 10,
  });

  const res = await fetch(`${CSE_BASE}?${params}`, {
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    const err = await res.json();
    console.warn('CSE error:', err?.error?.message);
    return [];
  }

  const data = await res.json();
  if (!data.items) return [];

  return data.items.map(item => {
    const isLinkedIn = item.link.includes('linkedin.com');
    const isX = item.link.includes('x.com') || item.link.includes('twitter.com');

    return {
      id: btoa(item.link).slice(0, 20),
      title: cleanTitle(item.title),
      company: extractCompany(item.snippet, isLinkedIn),
      url: item.link,
      remote: /remot/i.test(item.snippet + item.title),
      tags: extractTags(item.title + ' ' + item.snippet),
      source: isLinkedIn ? 'linkedin' : isX ? 'x' : 'google',
      published_at: new Date().toISOString(), // Google CSE no da fecha exacta
      time: 'reciente',
      snippet: item.snippet?.slice(0, 150) || '',
    };
  });
}

function cleanTitle(title) {
  // Limpiar sufijos de LinkedIn/X del título
  return title
    .replace(/\s*[-|]\s*LinkedIn.*$/i, '')
    .replace(/\s*[-|]\s*Twitter.*$/i, '')
    .replace(/\s*[-|]\s*X\.com.*$/i, '')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractCompany(snippet, isLinkedIn) {
  if (!snippet) return '';
  // LinkedIn snippets suelen empezar con "Nombre · Cargo en Empresa"
  const match = snippet.match(/en ([A-Z][^·\n.]{2,40})/);
  return match ? match[1].trim() : '';
}

function extractTags(text) {
  const techMap = [
    'react','vue','angular','node','python','javascript','typescript',
    'java','php','ruby','rails','django','flutter','swift','kotlin',
    'devops','docker','kubernetes','aws','gcp','postgres','mysql',
    'graphql','next.js','fastapi','spring','laravel','fullstack','backend','frontend'
  ];
  return techMap.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(text)).slice(0, 4);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
