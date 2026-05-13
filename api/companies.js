// api/companies.js — Vercel Serverless Function
// Scraping de careers pages de empresas tech argentinas

// Muchas empresas usan Greenhouse, Lever o Workday como ATS
// Estos tienen APIs JSON públicas — no necesitamos HTML scraping
const COMPANIES = [
  {
    name: 'Globant',
    type: 'greenhouse',
    boardToken: 'globant', // career.globant.com usa Greenhouse
    country: 'AR',
  },
  {
    name: 'Etermax',
    type: 'greenhouse',
    boardToken: 'etermax',
    country: 'AR',
  },
  {
    name: 'Satellogic',
    type: 'greenhouse',
    boardToken: 'satellogic',
    country: 'AR',
  },
  {
    name: 'Auth0',
    type: 'greenhouse',
    boardToken: 'auth0',
    country: 'AR',
  },
  {
    name: 'Wolox',
    type: 'greenhouse',
    boardToken: 'wolox',
    country: 'AR',
  },
  {
    name: 'Avature',
    type: 'greenhouse',
    boardToken: 'avature',
    country: 'AR',
  },
  {
    name: 'Mercado Libre',
    type: 'custom',
    fetchFn: fetchMercadoLibre,
    country: 'AR',
  },
  {
    name: 'PedidosYa',
    type: 'lever',
    boardToken: 'pedidosya',
    country: 'AR',
  },
];

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ source: 'cache', jobs: cache.data, total: cache.data.length });
  }

  const allJobs = [];

  await Promise.allSettled(
    COMPANIES.map(company => fetchCompany(company))
  ).then(results => {
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        allJobs.push(...r.value);
      }
    });
  });

  // Filtrar solo Argentina
  const arJobs = allJobs.filter(job => {
    const loc = (job.location || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    return loc.includes('argentin') || loc.includes('buenos aires') ||
           loc.includes('remote') || loc.includes('remoto') ||
           desc.includes('argentin') || !job.location;
  });

  arJobs.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  cache = { data: arJobs, timestamp: now };

  return res.json({ source: 'live', jobs: arJobs, total: arJobs.length });
}

async function fetchCompany(company) {
  try {
    if (company.type === 'greenhouse') return await fetchGreenhouse(company);
    if (company.type === 'lever') return await fetchLever(company);
    if (company.type === 'custom') return await company.fetchFn(company);
    return [];
  } catch (err) {
    console.warn(`Failed ${company.name}:`, err.message);
    return [];
  }
}

// Greenhouse ATS — API JSON pública
async function fetchGreenhouse(company) {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${company.boardToken}/jobs?content=true`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return [];
  const data = await res.json();

  return (data.jobs || []).map(job => ({
    id: `${company.boardToken}-${job.id}`,
    title: job.title || '',
    company: company.name,
    url: job.absolute_url || `https://boards.greenhouse.io/${company.boardToken}/jobs/${job.id}`,
    location: job.location?.name || '',
    remote: /remote|remoto/i.test(job.location?.name || ''),
    tags: extractTags(job.title + ' ' + (job.content || '')),
    source: 'company',
    company_name: company.name,
    published_at: job.updated_at || new Date().toISOString(),
    time: timeAgo(job.updated_at),
  }));
}

// Lever ATS — API JSON pública
async function fetchLever(company) {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${company.boardToken}?mode=json`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return [];
  const data = await res.json();

  return (data || []).map(job => ({
    id: `${company.boardToken}-${job.id}`,
    title: job.text || '',
    company: company.name,
    url: job.hostedUrl || job.applyUrl || '',
    location: job.categories?.location || '',
    remote: /remote|remoto/i.test(job.categories?.location || ''),
    tags: extractTags(job.text + ' ' + (job.categories?.team || '')),
    source: 'company',
    company_name: company.name,
    published_at: job.createdAt ? new Date(job.createdAt).toISOString() : new Date().toISOString(),
    time: timeAgo(job.createdAt ? new Date(job.createdAt).toISOString() : null),
  }));
}

// Mercado Libre — careers custom
async function fetchMercadoLibre(company) {
  // MeLi usa su propio ATS en careers-meli.mercadolibre.com
  // Intentamos el endpoint JSON que usan internamente
  const res = await fetch(
    'https://careers-meli.mercadolibre.com/api/jobs?location=Argentina&limit=50',
    {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    }
  );
  if (!res.ok) return [];
  const data = await res.json();

  return (data.jobs || data.results || []).map(job => ({
    id: `meli-${job.id || Math.random()}`,
    title: job.title || job.name || '',
    company: 'Mercado Libre',
    url: job.url || job.apply_url || 'https://careers-meli.mercadolibre.com',
    location: job.location || 'Argentina',
    remote: /remote|remoto/i.test(job.location || ''),
    tags: extractTags(job.title || ''),
    source: 'company',
    company_name: 'Mercado Libre',
    published_at: job.published_at || new Date().toISOString(),
    time: timeAgo(job.published_at),
  }));
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

function timeAgo(dateVal) {
  if (!dateVal) return 'reciente';
  const ms = typeof dateVal === 'number' ? dateVal * 1000 : new Date(dateVal).getTime();
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} hr`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} días`;
}
