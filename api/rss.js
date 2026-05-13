// api/rss.js — Vercel Serverless Function
// Parsea RSS feeds de LinkedIn Jobs y We Work Remotely sin dependencias externas

const FEEDS = {
  indeed: [
    'https://ar.indeed.com/rss?q=desarrollador&l=Argentina&sort=date',
    'https://ar.indeed.com/rss?q=developer&l=Argentina&sort=date',
    'https://ar.indeed.com/rss?q=programador&l=Argentina&sort=date',
    'https://ar.indeed.com/rss?q=react+developer&l=Argentina&sort=date',
    'https://ar.indeed.com/rss?q=python+developer&l=Argentina&sort=date',
  ],
};

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { source = 'all' } = req.query;

  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_TTL) {
    const filtered = source === 'all'
      ? cache.data
      : cache.data.filter(j => j.source === source);
    return res.json({ source: 'cache', jobs: filtered, total: filtered.length });
  }

  try {
    const feedsToFetch = source === 'all'
      ? Object.entries(FEEDS)
      : [[source, FEEDS[source] || []]];

    const allJobs = [];

    await Promise.allSettled(
      feedsToFetch.flatMap(([sourceName, urls]) =>
        urls.map(url => fetchAndParse(url, sourceName))
      )
    ).then(results => {
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          allJobs.push(...r.value);
        }
      });
    });

    // Deduplicar por URL
    const seen = new Set();
    const unique = allJobs.filter(job => {
      if (seen.has(job.url)) return false;
      seen.add(job.url);
      return true;
    });

    // Ordenar por fecha descendente
    unique.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    cache = { data: unique, timestamp: now };

    const result = source === 'all' ? unique : unique.filter(j => j.source === source);
    return res.json({ source: 'live', jobs: result, total: result.length });

  } catch (err) {
    console.error('RSS error:', err);
    return res.status(500).json({ error: 'Error fetching RSS', details: err.message });
  }
}

async function fetchAndParse(url, sourceName) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; devjobs-ar/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) return [];

    const xml = await res.text();
    return parseRSS(xml, sourceName);

  } catch (err) {
    console.warn(`Feed failed: ${url}`, err.message);
    return [];
  }
}

function parseRSS(xml, sourceName) {
  const items = [];

  // Extraer todos los <item> del XML sin dependencias
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const title = extractTag(block, 'title');
    const url = extractTag(block, 'link') || extractTag(block, 'guid');
    const company = extractTag(block, 'author') ||
                    extractTag(block, 'dc:creator') ||
                    extractAttr(block, 'source', 'url') ||
                    extractTag(block, 'source') || '';
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || '';
    const description = stripHtml(extractTag(block, 'description') || '');
    const category = extractAllTags(block, 'category');

    if (!title || !url) continue;

    // Filtrar solo tech para feeds genéricos
    const techKeywords = /react|vue|angular|node|python|javascript|typescript|java|php|ruby|rails|django|flutter|swift|kotlin|android|ios|devops|docker|kubernetes|aws|backend|frontend|fullstack|developer|desarrollador|data|ml|machine learning/i;
    const fullText = title + ' ' + description + ' ' + category.join(' ');
    if (!techKeywords.test(fullText)) continue;

    const tags = extractTags(fullText);
    const isRemote = /remot|remote|trabajo remoto|wfh/i.test(fullText);
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();

    items.push({
      id: btoa(url).slice(0, 20),
      title: cleanTitle(title),
      company: cleanCompany(company, sourceName),
      url: cleanUrl(url),
      remote: isRemote,
      tags,
      source: sourceName,
      published_at: publishedAt,
      time: timeAgo(publishedAt),
    });
  }

  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function cleanTitle(title) {
  return title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
}

function cleanCompany(company, source) {
  if (company) return company.replace(/<[^>]+>/g,'').trim();
  const map = { weworkremotely: 'We Work Remotely', linkedin: 'LinkedIn Jobs', remoteok: 'Remote OK' };
  return map[source] || source;
}

function cleanUrl(url) {
  // LinkedIn a veces mete el URL después de un ?
  if (url.includes('linkedin.com/jobs/view')) return url.split('?')[0];
  return url;
}

function extractTags(text) {
  const techMap = [
    'react','vue','angular','node','python','javascript','typescript',
    'java','php','ruby','rails','django','flutter','swift','kotlin',
    'devops','docker','kubernetes','aws','gcp','azure','postgres','mysql',
    'graphql','rest','next.js','nuxt','fastapi','spring','laravel'
  ];
  return techMap.filter(t => new RegExp(`\\b${t}\\b`, 'i').test(text)).slice(0, 5);
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
