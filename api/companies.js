// api/companies.js — Vercel Serverless Function
// Greenhouse + Lever APIs públicas con board tokens verificados

const GREENHOUSE_COMPANIES = [
  { name: 'Nubank', token: 'nubank' },
  { name: 'Speechify', token: 'speechify' },
  { name: 'Varicent', token: 'varicent' },
  { name: 'Clara', token: 'clara' },
];

const LEVER_COMPANIES = [
  { name: 'dLocal', token: 'dlocal' },
  { name: 'Coderio', token: 'coderio' },
  { name: 'Bluelight', token: 'bluelightconsulting' },
  { name: 'Binance', token: 'binance' },
];

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 30 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ source: 'cache', jobs: cache.data, total: cache.data.length });
  }

  const allJobs = [];

  await Promise.allSettled([
    ...GREENHOUSE_COMPANIES.map(c => fetchGreenhouse(c)),
    ...LEVER_COMPANIES.map(c => fetchLever(c)),
  ]).then(results => {
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) allJobs.push(...r.value);
    });
  });

  // Filtrar solo Argentina — más estricto
  const arJobs = allJobs.filter(job => {
    const loc = (job.location || '').toLowerCase();
    return loc.includes('argentin') || loc.includes('buenos aires') ||
           loc.includes('córdoba') || loc.includes('cordoba') ||
           loc.includes('rosario') || loc.includes('mendoza') ||
           loc.includes('la plata') || loc.includes('mar del plata') ||
           loc.includes('salta') || loc === '';
  });

  // Deduplicar por título + empresa (Bluelight publica mismo job por ciudad)
  const seen = new Set();
  const dedupedJobs = arJobs.filter(job => {
    const key = `${job.company}-${job.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  dedupedJobs.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  cache = { data: dedupedJobs, timestamp: now };

  return res.json({ source: 'live', jobs: dedupedJobs, total: dedupedJobs.length });
}

async function fetchGreenhouse({ name, token }) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();

    return (data.jobs || []).map(job => ({
      id: `gh-${token}-${job.id}`,
      title: job.title || '',
      company: name,
      url: job.absolute_url || `https://boards.greenhouse.io/${token}/jobs/${job.id}`,
      location: job.location?.name || '',
      remote: /remote|remoto/i.test(job.location?.name || ''),
      tags: extractTags(job.title || ''),
      source: 'company',
      published_at: job.updated_at || new Date().toISOString(),
      time: timeAgo(job.updated_at),
    }));
  } catch (err) {
    console.warn(`Greenhouse ${name} failed:`, err.message);
    return [];
  }
}

async function fetchLever({ name, token }) {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${token}?mode=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();

    return (data || []).map(job => ({
      id: `lv-${token}-${job.id}`,
      title: job.text || '',
      company: name,
      url: job.hostedUrl || '',
      location: job.categories?.location || job.tags?.join(', ') || '',
      remote: /remote|remoto/i.test(job.categories?.location || ''),
      tags: extractTags(job.text + ' ' + (job.categories?.team || '')),
      source: 'company',
      published_at: job.createdAt ? new Date(job.createdAt).toISOString() : new Date().toISOString(),
      time: timeAgo(job.createdAt ? new Date(job.createdAt).toISOString() : null),
    }));
  } catch (err) {
    console.warn(`Lever ${name} failed:`, err.message);
    return [];
  }
}

function extractTags(text) {
  const techMap = ['react','vue','angular','node','python','javascript','typescript',
    'java','php','ruby','rails','django','flutter','swift','kotlin','devops',
    'docker','kubernetes','aws','gcp','postgres','mysql','graphql','next.js',
    'fastapi','spring','laravel','fullstack','backend','frontend'];
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
  return `hace ${Math.floor(hrs / 24)} días`;
}
