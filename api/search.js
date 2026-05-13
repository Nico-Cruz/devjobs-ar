// api/search.js — Vercel Serverless Function
// Google CSE unificado: posts sociales (LinkedIn/X) + careers pages empresas AR
// Cache de 30 min para no quemar el límite de 100 queries/día

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBV5kSOuP-OC1VOH1MBQFmDVt2oXkO4w-0';
const GOOGLE_CX = process.env.GOOGLE_CX || 'c5328d13e20ba4413';
const CSE_BASE = 'https://www.googleapis.com/customsearch/v1';

// Total: 10 queries por refresh. Con cache 30min = máx 48 refreshes/día = 480 queries/día
// Tier gratuito: 100/día. Solución: cache 6hs en producción o upgrade a $5/1000
const QUERIES = [
  // Posts sociales — LinkedIn
  { q: 'site:linkedin.com/posts "buscamos desarrollador" Argentina', type: 'linkedin' },
  { q: 'site:linkedin.com/posts "hiring developer" Argentina remoto', type: 'linkedin' },
  { q: 'site:linkedin.com/posts "estamos buscando" developer Argentina', type: 'linkedin' },
  // Posts sociales — X
  { q: 'site:x.com "buscamos desarrollador" OR "hiring developer" Argentina', type: 'x' },
  // Careers pages empresas AR
  { q: 'site:career.globant.com Argentina developer', type: 'company', company: 'Globant' },
  { q: 'site:careers-meli.mercadolibre.com developer engineer', type: 'company', company: 'Mercado Libre' },
  { q: 'site:despegar.com/careers OR site:careers.despegar.com developer', type: 'company', company: 'Despegar' },
  { q: 'site:etermax.com developer engineer Argentina', type: 'company', company: 'Etermax' },
  { q: 'site:naranjax.com developer engineer Argentina', type: 'company', company: 'Naranja X' },
  { q: 'site:pedidosya.com careers developer Argentina', type: 'company', company: 'PedidosYa' },
];

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas — conservar queries

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { type } = req.query; // ?type=social | company | all

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    const filtered = filterByType(cache.data, type);
    return res.json({ source: 'cache', jobs: filtered, total: filtered.length });
  }

  try {
    const results = [];
    const chunks = chunkArray(QUERIES, 3);

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map(q => searchGoogle(q))
      );
      settled.forEach(r => {
        if (r.status === 'fulfilled' && r.value) results.push(...r.value);
      });
    }

    // Deduplicar por URL
    const seen = new Set();
    const unique = results.filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });

    cache = { data: unique, timestamp: now };

    const filtered = filterByType(unique, type);
    return res.json({ source: 'live', jobs: filtered, total: filtered.length });

  } catch (err) {
    console.error('Search CSE error:', err);
    return res.status(500).json({ error: 'Error fetching jobs', details: err.message });
  }
}

function filterByType(jobs, type) {
  if (!type || type === 'all') return jobs;
  if (type === 'social') return jobs.filter(j => ['linkedin', 'x'].includes(j.source));
  if (type === 'company') return jobs.filter(j => j.source === 'company');
  return jobs;
}

async function searchGoogle(queryObj) {
  const params = new URLSearchParams({
    key: GOOGLE_API_KEY,
    cx: GOOGLE_CX,
    q: queryObj.q,
    num: 10,
    ...(queryObj.type === 'social' ? { dateRestrict: 'd7' } : {}),
  });

  const res = await fetch(`${CSE_BASE}?${params}`, {
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn('CSE error:', err?.error?.message);
    return [];
  }

  const data = await res.json();
  if (!data.items) return [];

  return data.items.map(item => {
    const isCompany = queryObj.type === 'company';

    return {
      id: btoa(item.link).slice(0, 20),
      title: cleanTitle(item.title, queryObj.company),
      company: isCompany
        ? (queryObj.company || extractDomain(item.link))
        : extractSocialCompany(item.snippet),
      url: item.link,
      remote: /remot/i.test(item.snippet + item.title),
      tags: extractTags(item.title + ' ' + (item.snippet || '')),
      source: queryObj.type,
      published_at: new Date().toISOString(),
      time: 'reciente',
    };
  }).filter(job => isValidJob(job, queryObj.type));
}

function isValidJob(job, type) {
  if (type !== 'company') return true;
  return /job|jobs|career|careers|position|opening|vacante|empleo/i.test(job.url);
}

function cleanTitle(title, company) {
  return title
    .replace(/\s*[-|–]\s*(Globant|MercadoLibre|Mercado Libre|Naranja X|Despegar|etermax|Uala|PedidosYa|LinkedIn|X\.com|Twitter).*$/i, '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
}

function extractDomain(url) {
  const map = {
    'globant.com': 'Globant',
    'mercadolibre.com': 'Mercado Libre',
    'naranjax.com': 'Naranja X',
    'despegar.com': 'Despegar',
    'etermax.com': 'Etermax',
    'uala.com.ar': 'Uala',
    'pedidosya.com': 'PedidosYa',
  };
  for (const [domain, name] of Object.entries(map)) {
    if (url.includes(domain)) return name;
  }
  return 'Empresa AR';
}

function extractSocialCompany(snippet) {
  if (!snippet) return '';
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
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
