// api/jobs.js — Vercel Serverless Function
// GET /api/jobs?category=development&page=1&per_page=20&country=AR

const GETONBOARD_BASE = 'https://www.getonbrd.com/api/v0';

// Cache en memoria (se resetea con cada cold start, ~5-15 min en Vercel free)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

export default async function handler(req, res) {
  // CORS para el frontend en Netlify/Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { category = 'programming', page = 1, per_page = 20, search = '' } = req.query;

  // Servir desde cache si es reciente
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    return res.json({ source: 'cache', ...cache.data });
  }

  try {
    let jobs = [];

    if (search) {
      // Búsqueda por texto libre
      const searchRes = await fetch(
        `${GETONBOARD_BASE}/search/jobs?q=${encodeURIComponent(search)}&per_page=${per_page}&page=${page}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const searchData = await searchRes.json();
      jobs = searchData.data || [];
    } else {
      // Jobs por categoría — programming es la más relevante para AR tech
      const catRes = await fetch(
        `${GETONBOARD_BASE}/categories/${category}/jobs?per_page=${per_page}&page=${page}&expand[]=company&expand[]=tags`,
        { headers: { 'Accept': 'application/json' } }
      );
      const catData = await catRes.json();
      jobs = catData.data || [];
    }

    // Normalizar estructura para el frontend
    const normalized = jobs.map(job => {
      const attrs = job.attributes || {};
      const company = attrs.company?.data?.attributes || {};
      const tags = (attrs.tags?.data || []).map(t => t.attributes?.name || '').filter(Boolean);

      return {
        id: job.id,
        title: attrs.title || '',
        company: company.name || attrs.company_name || '',
        company_url: company.url || '',
        url: attrs.url || `https://www.getonbrd.com/jobs/${job.id}`,
        remote: attrs.remote || false,
        remote_modality: attrs.remote_modality || null,
        min_salary: attrs.min_salary || null,
        max_salary: attrs.max_salary || null,
        published_at: attrs.published_at || null,
        country: attrs.country || 'AR',
        tags: tags,
        source: 'getonboard',
        time: timeAgo(attrs.published_at),
      };
    });

    const result = { jobs: normalized, total: normalized.length, page: Number(page) };

    // Guardar en cache
    cache = { data: result, timestamp: now };

    return res.json({ source: 'live', ...result });

  } catch (err) {
    console.error('GetOnBoard API error:', err);
    return res.status(500).json({ error: 'Error fetching jobs', details: err.message });
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return 'reciente';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} hr`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} días`;
}
