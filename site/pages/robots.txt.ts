import type { APIRoute } from 'astro';

// Generated rather than copied from public/: the sitemap line must be an
// absolute URL, and the origin and base change between GitHub Pages and a
// custom domain.
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL(`${import.meta.env.BASE_URL}sitemap-index.xml`, site);
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap.href}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
