import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, Check, ChevronRight, ExternalLink, Lock, Newspaper, Share2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';
import { SidebarTrigger, useSidebar } from '../components/ui/sidebar';
import { ChartEmbed } from '../components/ChartEmbed';
import { NativeReportChart, type ReportChartSpec } from '../components/NativeReportChart';
import { useTranslation } from 'react-i18next';

interface TocHeading {
  id: string;
  text: string;
  number: string;
}

interface ReportChartEntry {
  actionName: string;
  chartFilename: string;
  title: string;
  section: string;
  chartSpec?: ReportChartSpec;
}

interface ReportSearchLink {
  title: string;
  url: string;
  publishedDate?: string;
}

interface ReportSearchResult {
  actionName: string;
  query: string;
  links: ReportSearchLink[];
}

interface ReportMetadata {
  date: string;
  target: string;
  generatedAt: number;
  charts: ReportChartEntry[];
  searchResults: ReportSearchResult[];
}

interface DailyReportResponse {
  hasReport?: boolean;
  fileName?: string;
  date?: string;
  metadata?: ReportMetadata | null;
}

interface HtmlSection {
  id: string;
  text: string;
  html: string;
}

const BASE_URL =
  import.meta.env.VITE_SERVER_BASE_URL ||
  window.location.origin;

const encodeReportPath = (relativePath: string) =>
  relativePath
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

// ── Helpers ──────────────────────────────────────────────

const stripTags = (html: string) => html.replace(/<[^>]+>/g, '');

const cleanHeadingText = (text: string) =>
  stripTags(text)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const toAnchorId = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);

function extractHeadingsFromHtml(html: string): TocHeading[] {
  // Match both h2 and h3 — the report uses h3 for numbered sections like "1. Executive Summary"
  const regex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const headings: TocHeading[] = [];
  let match: RegExpExecArray | null;
  let idx = 1;

  while ((match = regex.exec(html)) !== null) {
    const text = cleanHeadingText(match[1]);
    if (!text) continue;
    // Only include numbered section headings (e.g. "1. Executive Summary")
    const numberedMatch = text.match(/^(\d+)\.\s*(.*)/);
    if (!numberedMatch) continue;
    const cleanText = numberedMatch[2];
    headings.push({ id: toAnchorId(text), text: cleanText, number: `${idx}` });
    idx++;
  }
  return headings;
}

function extractAnalysisBody(html: string): string {
  const bodyMatch = html.match(
    /<div\s+class="analysis-content">([\s\S]*?)<\/div>\s*(?:<div\s+class="generated-info">|$)/i
  );
  return bodyMatch?.[1]?.trim() ?? '';
}

function injectHeadingIds(html: string, headings: TocHeading[]): string {
  let idx = 0;
  // Inject IDs into numbered h2/h3 headings that match TOC entries
  return html.replace(/<(h[23])([^>]*)>([\s\S]*?)<\/h[23]>/gi, (fullMatch, tag, attrs, content) => {
    const text = cleanHeadingText(content);
    const isNumbered = /^\d+\.\s/.test(text);
    if (isNumbered && idx < headings.length) {
      const id = headings[idx].id;
      idx++;
      const cleanAttrs = attrs.replace(/\s*id="[^"]*"/g, '');
      return `<${tag}${cleanAttrs} id="${id}">${content}</${tag}>`;
    }
    return fullMatch;
  });
}

function sanitizeBodyHtml(html: string): string {
  let s = html;

  // Remove the duplicate report title (h2 "Comprehensive Cryptocurrency Analysis: Bitcoin (BTC)")
  s = s.replace(/<h2[^>]*>[\s\S]*?Comprehensive[\s\S]*?<\/h2>/i, '');

  // Remove "Date of Analysis: ..." paragraph right after the title
  s = s.replace(/<p>\s*<strong>Date of Analysis:<\/strong>[^<]*<\/p>/i, '');

  // Strip leading numbers from section headings and remove italic/em tags inside headings
  // Add card class directly to h3 (not a wrapper div) so browser nesting correction keeps it at top level
  s = s.replace(/<h([234])([^>]*)>([\s\S]*?)<\/h[234]>/gi, (_m, level, attrs, content) => {
    let cleaned = content.replace(/^\s*\d+\.\s*/, '');
    cleaned = cleaned.replace(/<\/?em>/gi, '');
    if (level === '2' || level === '3') {
      const cleanAttrs = attrs.replace(/\s*class="[^"]*"/g, '');
      return `<h${level}${cleanAttrs} class="section-heading">${cleaned}</h${level}>`;
    }
    return `<h${level}${attrs}>${cleaned}</h${level}>`;
  });

  // Fix orphan <li> not wrapped in <ul>: find consecutive <li>...</li> not inside <ul>/<ol>
  // Strategy: wrap runs of <li> that appear after non-list context
  s = s.replace(/<br>\s*<li>/g, '<li>'); // remove <br> before <li>
  s = s.replace(/<\/li>\s*<br>/g, '</li>'); // remove <br> after </li>

  // Wrap consecutive orphan <li> elements in <ul>
  // Split by tags, find runs of <li> not preceded by <ul>/<ol>
  s = s.replace(
    /(?<![<\/](?:ul|ol)>\s*)(<li>[\s\S]*?<\/li>(?:\s*<li>[\s\S]*?<\/li>)*)/gi,
    (match, _group, offset) => {
      // Check if already inside a <ul> or <ol>
      const before = s.slice(Math.max(0, offset - 200), offset);
      const lastUlOpen = Math.max(before.lastIndexOf('<ul'), before.lastIndexOf('<ol'));
      const lastUlClose = Math.max(before.lastIndexOf('</ul>'), before.lastIndexOf('</ol>'));
      if (lastUlOpen > lastUlClose) return match; // already inside list
      return `<ul>${match}</ul>`;
    }
  );

  // Clean up malformed bold/italic patterns like: <em> <strong>text:** *</em>
  s = s.replace(/<em>\s*<strong>(.*?)\*{1,2}<\/strong>\s*<\/em>/g, '<strong>$1</strong>');
  s = s.replace(/<em>\s*<strong>(.*?)\*{1,2}<\/em>/g, '<strong>$1</strong>');

  // Clean stray markdown asterisks: **text** → <strong>text</strong>
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return s;
}

// ── Section splitting ────────────────────────────────────

function splitBySections(html: string): HtmlSection[] {
  // Split at each numbered report section heading boundary
  const sectionRegex = /<h[23][^>]*class="section-heading"[^>]*>/gi;
  const indices: number[] = [];
  let m: RegExpExecArray | null;

  while ((m = sectionRegex.exec(html)) !== null) {
    indices.push(m.index);
  }

  if (indices.length === 0) {
    return [{ id: '_all', text: '', html }];
  }

  const sections: HtmlSection[] = [];

  // Content before first section heading (if any)
  if (indices[0] > 0) {
    const preHtml = html.slice(0, indices[0]).trim();
    if (preHtml) {
      sections.push({ id: '_preamble', text: '', html: preHtml });
    }
  }

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1] : html.length;
    const sectionHtml = html.slice(start, end);

    // Extract heading text from the first section heading in this section
    const headingMatch = sectionHtml.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
    const text = headingMatch ? cleanHeadingText(headingMatch[1]) : '';

    // Extract the id attribute from the section heading
    const idMatch = sectionHtml.match(/<h[23][^>]*id="([^"]*)"[^>]*>/i);
    const id = idMatch?.[1] || toAnchorId(text) || `section-${i}`;

    sections.push({ id, text, html: sectionHtml });
  }

  return sections;
}

// ── Section matching helpers ─────────────────────────────

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

function getChartsForSection(sectionText: string, charts?: ReportChartEntry[]): ReportChartEntry[] {
  if (!charts || charts.length === 0 || !sectionText) return [];
  const norm = normalize(sectionText);
  return charts.filter(c => {
    const cNorm = normalize(c.section);
    // Check if section heading contains the chart's target section or vice versa
    return norm.includes(cNorm) || cNorm.includes(norm);
  });
}

function isNewsSection(sectionText: string): boolean {
  const norm = normalize(sectionText);
  return norm.includes('news') || norm.includes('research') || norm.includes('recent developments');
}

// ── Search Links Card ────────────────────────────────────

function SearchLinksCard({ results }: { results: ReportSearchResult[] }) {
  const { t } = useTranslation();
  // Deduplicate links across all search results by URL
  const allLinks: ReportSearchLink[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const link of r.links) {
      if (!seen.has(link.url)) {
        seen.add(link.url);
        allLinks.push(link);
      }
    }
  }

  if (allLinks.length === 0) return null;

  return (
    <div className="my-6 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-white/[0.02] overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-white/10 bg-white/60 dark:bg-white/[0.03]">
        <Newspaper className="h-4 w-4 text-emerald-500" />
        <h4 className="text-sm font-medium text-gray-900 dark:text-white">{t('reportsPage.sourcesAndReferences')}</h4>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{t('reportsPage.sourcesCount', { count: allLinks.length })}</span>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-white/5">
        {allLinks.map((link, i) => (
          <a
            key={`${link.url}-${i}`}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-3 px-5 py-3 hover:bg-gray-100/50 dark:hover:bg-white/[0.03] transition-colors group"
          >
            <ExternalLink className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-gray-400 dark:text-gray-500 group-hover:text-emerald-500 transition-colors" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors truncate">
                {link.title}
              </p>
              {link.publishedDate && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{link.publishedDate}</p>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ── Prose class constant ─────────────────────────────────

const PROSE_CLASSES = `report-content prose prose-gray dark:prose-invert max-w-none
  prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-headings:not-italic
  prose-h1:text-[28px] prose-h1:font-bold prose-h1:mt-14 prose-h1:mb-6 prose-h1:text-gray-900 dark:prose-h1:text-white
  prose-h2:text-[28px] prose-h2:font-bold prose-h2:mt-14 prose-h2:mb-6 prose-h2:text-gray-900 dark:prose-h2:text-white prose-h2:pb-3 prose-h2:border-b prose-h2:border-gray-200 dark:prose-h2:border-white/10
  prose-h3:text-2xl prose-h3:font-bold prose-h3:mt-0 prose-h3:mb-0 prose-h3:text-gray-900 dark:prose-h3:text-white prose-h3:pb-0 prose-h3:border-b-0
  prose-h4:text-lg prose-h4:font-semibold prose-h4:mt-8 prose-h4:mb-3 prose-h4:text-gray-800 dark:prose-h4:text-gray-200
  prose-p:text-[15px] prose-p:leading-[1.8] prose-p:text-gray-600 dark:prose-p:text-gray-300 prose-p:mb-4
  prose-strong:text-gray-900 dark:prose-strong:text-white prose-strong:font-semibold
  prose-li:text-[15px] prose-li:text-gray-600 dark:prose-li:text-gray-300 prose-li:leading-[1.8]
  prose-ul:my-4 prose-ol:my-4
  prose-a:text-emerald-600 dark:prose-a:text-emerald-400 prose-a:no-underline hover:prose-a:underline
  prose-blockquote:border-l-emerald-400 prose-blockquote:bg-gray-50 dark:prose-blockquote:bg-white/5 prose-blockquote:rounded-r-lg prose-blockquote:py-1 prose-blockquote:not-italic
  prose-code:text-sm prose-code:bg-gray-100 dark:prose-code:bg-white/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-normal
  prose-table:text-sm prose-table:border-collapse
  prose-th:bg-gray-50 dark:prose-th:bg-white/5 prose-th:text-gray-600 dark:prose-th:text-gray-300 prose-th:font-medium prose-th:text-left prose-th:px-4 prose-th:py-2.5
  prose-td:px-4 prose-td:py-2 prose-td:text-gray-600 dark:prose-td:text-gray-400 prose-td:border-t prose-td:border-gray-100 dark:prose-td:border-white/5
  prose-hr:border-gray-100 dark:prose-hr:border-white/5 prose-hr:my-10
  prose-em:text-gray-500 dark:prose-em:text-gray-400`;

// ── Page Component ───────────────────────────────────────

export default function DailyReportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  // DailyAnalysis closes the AppSidebar before navigating into the report for a focused view;
  // restore it on the way back so home doesn't render with the sidebar collapsed.
  const { setOpen: setSidebarOpen } = useSidebar();
  // When the chat opened this report (via ComprehensiveActionTab), it stashes the
  // originating chat path in router state. Latch it once so it survives in-page state
  // updates that would otherwise replace location.state.
  const fromPathRef = useRef<string | null>(null);
  if (fromPathRef.current === null) {
    const stashed = (location.state as { fromPath?: unknown } | null)?.fromPath;
    fromPathRef.current = typeof stashed === 'string' && stashed.startsWith('/chat/') ? stashed : '';
  }
  const goHome = useCallback(() => {
    setSidebarOpen(true);
    navigate(fromPathRef.current || '/');
  }, [navigate, setSidebarOpen]);
  const { t, i18n } = useTranslation();
  const [rawHtml, setRawHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reportMeta, setReportMeta] = useState<{ fileName?: string; date?: string }>({});
  const [metadata, setMetadata] = useState<ReportMetadata | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const requestedFileName = searchParams.get('fileName');
  // `source=ondemand` reuses this layout for comprehensive-analysis reports
  // saved by `saveReport` into `Reports/`. The HTML format is identical
  // (same htmlGenerator), only the location and metadata-fetch differ.
  const source = searchParams.get('source') === 'ondemand' ? 'ondemand' : 'daily';
  // S3 proxy URL passed by openReport when the local file is no longer on disk
  // (e.g. after a container redeploy). Used as a fallback data-source only —
  // the user still sees the sectioned TOC viewer, not the raw S3 file.
  const requestedReportUrl = searchParams.get('reportUrl');

  // Fetch metadata then HTML
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setAuthRequired(false);
        setError(false);

        let resolvedFileName: string | undefined;
        let metaForState: ReportMetadata | null = null;
        let dateForState: string | undefined;

        if (source === 'daily') {
          const metaUrl = new URL(`${BASE_URL}/daily-analysis`);
          if (requestedFileName) {
            metaUrl.searchParams.set('fileName', requestedFileName);
          }

          const metaRes = await fetch(metaUrl.toString(), {
            credentials: 'include',
          });
          if (metaRes.status === 401) {
            if (!cancelled) {
              setAuthRequired(true);
              setLoading(false);
            }
            return;
          }
          if (!metaRes.ok) {
            throw new Error(`Failed to fetch daily report metadata: ${metaRes.status}`);
          }
          const meta = (await metaRes.json()) as DailyReportResponse;

          if (!meta.hasReport || !meta.fileName) {
            if (!cancelled) { setError(true); setLoading(false); }
            return;
          }

          resolvedFileName = meta.fileName;
          metaForState = meta.metadata ?? null;
          dateForState = meta.date;
        } else {
          // On-demand reports: fileName is required since there's no "latest"
          // pointer; metadata sidecar is fetched directly from the same dir.
          if (!requestedFileName) {
            if (!cancelled) { setError(true); setLoading(false); }
            return;
          }
          resolvedFileName = requestedFileName;
          const sidecarName = requestedFileName.replace(/\.html?$/i, '.meta.json');
          // Try local sidecar first; fall back to S3 (replace .html with .meta.json in the S3 path).
          const localSidecarUrl = `${BASE_URL}/reports/${encodeReportPath(`Reports/${sidecarName}`)}`;
          const s3SidecarUrl = requestedReportUrl
            ? `${BASE_URL}${requestedReportUrl.replace(/\.html?$/i, '.meta.json')}`
            : null;
          const sidecarUrls = [localSidecarUrl, ...(s3SidecarUrl ? [s3SidecarUrl] : [])];
          for (const sidecarUrl of sidecarUrls) {
            try {
              const sidecarRes = await fetch(sidecarUrl, { credentials: 'include' });
              if (sidecarRes.ok) {
                const json = await sidecarRes.json();
                metaForState = (json && typeof json === 'object' ? json : null) as ReportMetadata | null;
                dateForState = (json?.date as string | undefined) ?? undefined;
                break;
              }
            } catch {
              // Sidecar is optional — TOC + sections come from the HTML itself.
            }
          }
        }

        if (!cancelled && resolvedFileName) {
          setReportMeta({
            fileName: resolvedFileName,
            date: dateForState,
          });
          setMetadata(metaForState);
        }

        const reportPath = source === 'daily'
          ? `DailyReports/${resolvedFileName}`
          : `Reports/${resolvedFileName}`;
        const localReportUrl = `${BASE_URL}/reports/${encodeReportPath(reportPath)}`;
        let htmlRes = await fetch(localReportUrl, { credentials: 'include' });

        // If local file is gone (e.g. after container redeploy) and the caller
        // provided an S3 proxy URL, fall back to it so the viewer still works.
        if (!htmlRes.ok && source === 'ondemand' && requestedReportUrl) {
          htmlRes = await fetch(`${BASE_URL}${requestedReportUrl}`, { credentials: 'include' });
        }

        if (htmlRes.status === 401) {
          if (!cancelled) {
            setAuthRequired(true);
            setLoading(false);
          }
          return;
        }
        if (!htmlRes.ok) {
          throw new Error(`Failed to fetch report HTML: ${htmlRes.status}`);
        }
        const html = await htmlRes.text();

        if (!cancelled) {
          setRawHtml(html);
          setLoading(false);
        }
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [requestedFileName, source, requestedReportUrl]);

  const headings = useMemo(() => (rawHtml ? extractHeadingsFromHtml(rawHtml) : []), [rawHtml]);
  const bodyHtml = useMemo(() => {
    if (!rawHtml) return '';
    const body = extractAnalysisBody(rawHtml);
    if (!body) return '';
    const withIds = injectHeadingIds(body, headings);
    return sanitizeBodyHtml(withIds);
  }, [rawHtml, headings]);

  // Split body HTML into sections for inline chart/link injection
  const sections = useMemo(() => {
    if (!bodyHtml) return [];
    return splitBySections(bodyHtml);
  }, [bodyHtml]);

  const hasMetadata = metadata && (
    (metadata.charts && metadata.charts.length > 0) ||
    (metadata.searchResults && metadata.searchResults.length > 0)
  );

  // Scroll-spy
  useEffect(() => {
    const container = contentRef.current;
    if (!container || headings.length === 0) return;

    const update = () => {
      const offset = 100;
      let current = headings[0]?.id ?? null;
      for (const h of headings) {
        const el = container.querySelector(`#${CSS.escape(h.id)}`);
        if (el) {
          const rect = el.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          if (rect.top - containerRect.top <= offset) {
            current = h.id;
          } else {
            break;
          }
        }
      }
      setActiveId(current);
    };

    container.addEventListener('scroll', update, { passive: true });
    update();
    return () => container.removeEventListener('scroll', update);
  }, [headings, bodyHtml]);

  const scrollTo = useCallback((id: string) => {
    const container = contentRef.current;
    if (!container) return;
    const el = container.querySelector(`#${CSS.escape(id)}`);
    if (el) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      container.scrollTo({
        top: container.scrollTop + elRect.top - containerRect.top - 80,
        behavior: 'smooth',
      });
      setActiveId(id);
    }
  }, []);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString(i18n.language, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleShare = useCallback(async () => {
    const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
    if (!shareUrl) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const input = document.createElement('input');
        input.value = shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }

      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch (copyError) {
      console.error('Failed to copy daily report link:', copyError);
    }
  }, []);

  // Loading state
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen">
        <div className="flex flex-col items-center gap-4">
          <div className="relative h-10 w-10">
            <div className="absolute inset-0 rounded-full border-2 border-gray-200 dark:border-gray-700" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-emerald-500 animate-spin" />
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('reportsPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (authRequired) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-screen px-4">
        <div className="max-w-md text-center space-y-6">
          <div className="mx-auto w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <Lock className="h-10 w-10 text-gray-400 dark:text-gray-500" aria-hidden />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
              {t('reportsPage.signInRequiredTitle')}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
              {t('reportsPage.signInRequiredDescription')}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              type="button"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => navigate('/signin')}
            >
              {t('auth.loginPrompt.login')}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => navigate('/signup')}
            >
              {t('auth.loginPrompt.signup')}
            </Button>
          </div>
          <button
            type="button"
            onClick={goHome}
            className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            {t('reportsPage.backToHome')}
          </button>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !bodyHtml) {
    return (
      <div className="flex-1 flex items-center justify-center h-screen">
        <div className="text-center space-y-4">
          <p className="text-gray-500 dark:text-gray-400">{t('reportsPage.noReport')}</p>
          <button
            onClick={goHome}
            className="text-sm text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            {t('reportsPage.backToHome')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* ── Left: Report TOC Sidebar ── */}
      <aside className="hidden lg:flex flex-col w-72 flex-shrink-0 border-r border-gray-200 dark:border-white/10 bg-gray-50/80 dark:bg-[hsl(229,40%,7%)]">
        {/* Back button */}
        <div className="flex items-center gap-2 px-4 h-14 flex-shrink-0 border-b border-gray-200 dark:border-white/10">
          <button
            onClick={goHome}
            className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>{t('reportsPage.home')}</span>
          </button>
        </div>

        {/* Report title */}
        <div className="px-5 pt-5 pb-4 flex-shrink-0">
          <h2 className="text-[13px] font-semibold text-gray-900 dark:text-white leading-snug">
            {t('reportsPage.comprehensiveAnalysisTitle', { asset: metadata?.target ?? reportMeta.fileName?.replace(/\.[^.]+$/, '') ?? 'BTC' })}
          </h2>
          {reportMeta.date && (
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
              {formatDate(reportMeta.date)}
            </p>
          )}
        </div>

        {/* Catalogue */}
        <div className="px-5 pb-2 flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t('reportsPage.catalogue')}
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-6 custom-scrollbar">
          <div className="space-y-0.5">
            {headings.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => scrollTo(h.id)}
                className={cn(
                  'group w-full text-left text-[12px] leading-relaxed rounded-lg px-3 py-2 transition-all duration-150',
                  'flex items-start gap-2.5',
                  activeId === h.id
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-medium'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
                )}
              >
                <span className={cn(
                  'w-5 flex-shrink-0 text-right tabular-nums text-[11px] mt-px',
                  activeId === h.id
                    ? 'text-emerald-500 dark:text-emerald-500'
                    : 'text-gray-300 dark:text-gray-600'
                )}>
                  {h.number}.
                </span>
                <span className="flex-1 line-clamp-2">{h.text}</span>
                <ChevronRight className={cn(
                  'h-3 w-3 mt-0.5 flex-shrink-0 opacity-0 transition-opacity',
                  activeId === h.id && 'opacity-60'
                )} />
              </button>
            ))}
          </div>
        </nav>
      </aside>

      {/* ── Right: Content Area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center justify-between h-14 px-4 md:px-8 border-b border-gray-200 dark:border-white/10 bg-white/80 dark:bg-[hsl(229,50%,6%)]/80 backdrop-blur-md flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Mobile sidebar trigger + back */}
            <div className="flex items-center gap-2 lg:hidden">
              <SidebarTrigger />
              <button
                onClick={goHome}
                className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </div>
            <div className="hidden sm:block">
              <h1 className="text-sm font-medium text-gray-900 dark:text-white">
                {t('reportsPage.comprehensiveAnalysisTitle', { asset: metadata?.target ?? reportMeta.fileName?.replace(/\.[^.]+$/, '') ?? 'BTC' })}
              </h1>
            </div>
          </div>

        </header>

        {/* Report body */}
        <div
          ref={contentRef}
          className="flex-1 overflow-y-auto"
        >
          <article className="max-w-5xl mx-auto px-4 md:px-6 py-8 md:py-10">
            {/* Report header */}
            <div className="mb-12">
              <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 mb-4 uppercase tracking-wider font-medium">
                <span>{t('reportsPage.dailyReport')}</span>
                <span className="text-gray-300 dark:text-gray-600">/</span>
                <span>{metadata?.target ?? 'BTC'}</span>
                {reportMeta.date && (
                  <>
                    <span className="text-gray-300 dark:text-gray-600">/</span>
                    <span>{formatDate(reportMeta.date)}</span>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white tracking-tight leading-tight">
                  {t('reportsPage.comprehensiveAnalysisTitle', { asset: metadata?.target ?? 'BTC' })}
                </h1>
                <button
                  type="button"
                  onClick={() => void handleShare()}
                  className="inline-flex items-center gap-2 self-start rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition-colors hover:border-emerald-300 hover:bg-emerald-100 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-400/30 dark:hover:bg-emerald-500/15"
                >
                  {shareCopied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
                  <span>{shareCopied ? t('reportsPage.linkCopied') : t('reportsPage.share')}</span>
                </button>
              </div>
              <div className="mt-4 h-px bg-gradient-to-r from-emerald-400/60 via-emerald-400/20 to-transparent" />
            </div>

            {/* Section heading card styles */}
            <style dangerouslySetInnerHTML={{ __html: `
              .report-content h2.section-heading,
              .report-content h3.section-heading {
                display: block;
                margin: 2.5rem 0 1.5rem 0 !important;
                padding: 0.875rem 1.25rem !important;
                border-radius: 0.75rem;
                border: none !important;
                border-left: 4px solid #10b981 !important;
                background: linear-gradient(135deg, #f0fdf4 0%, #f8fafc 100%);
                text-indent: 0 !important;
              }
              .report-content h2.section-heading:first-child,
              .report-content h3.section-heading:first-child {
                margin-top: 0 !important;
              }
              .dark .report-content h2.section-heading,
              .dark .report-content h3.section-heading {
                background: linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(255,255,255,0.03) 100%);
                border-left-color: #34d399 !important;
              }
            ` }} />

            {/* Report content — with inline charts and search links when metadata is available */}
            {hasMetadata ? (
              sections.map((section) => {
                const sectionCharts = getChartsForSection(section.text, metadata?.charts);
                const showSearchLinks = isNewsSection(section.text) && metadata?.searchResults && metadata.searchResults.length > 0;

                return (
                  <Fragment key={section.id}>
                    <div
                      className={PROSE_CLASSES}
                      dangerouslySetInnerHTML={{ __html: section.html }}
                    />
                    {sectionCharts.map((chart) => (
                      chart.chartSpec ? (
                        <NativeReportChart
                          key={chart.chartFilename}
                          chartSpec={chart.chartSpec}
                          title={chart.title}
                          actionName={chart.actionName}
                          className="my-6"
                        />
                      ) : (
                        <div
                          key={chart.chartFilename}
                          className="my-6 rounded-xl overflow-hidden border border-gray-200 dark:border-white/10 bg-white dark:bg-[hsl(229,50%,6%)]"
                        >
                          <ChartEmbed
                            chartUrl={`${BASE_URL}/reports/${encodeReportPath(
                              `${source === 'daily' ? 'DailyCharts' : 'Charts'}/${chart.chartFilename}`,
                            )}`}
                            chartPath={chart.chartFilename}
                            title={chart.title}
                            showHeader={true}
                          />
                        </div>
                      )
                    ))}
                    {showSearchLinks && (
                      <SearchLinksCard results={metadata!.searchResults} />
                    )}
                  </Fragment>
                );
              })
            ) : (
              /* Fallback: render entire body as single block (no metadata / old reports) */
              <div
                className={PROSE_CLASSES}
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
            )}

            {/* Footer */}
            <div className="mt-16 pt-8 border-t border-gray-100 dark:border-white/5">
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                {t('reportsPage.disclaimer')}
              </p>
            </div>
          </article>
        </div>
      </div>
    </div>
  );
}
