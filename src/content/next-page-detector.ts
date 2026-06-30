export interface NextPageCandidate {
  url: string;
  source: 'link-rel' | 'anchor-rel' | 'anchor-text' | 'anchor-attribute';
  score: number;
  label: string;
}

const TEXT_PATTERNS = [
  // 精确匹配完整文本
  /^(下一页|下页|下一章|下一篇|下一回|下一节|下一小节|下章|后页|下节|继续阅读|继续|下一章节)$/i,
  // 包含关键词的文本（允许前后有其他文字）
  /(下一页|下一页>>|下一章|下一篇|下一回|下一节|next page|next chapter|点击下一页|继续阅读|阅读下一章|下一章节)/i,
  /^(next|continue|next|pager next)$/i,
  /^[›»>]$/
];

const ATTRIBUTE_PATTERN = /(next|pager-next|pagination-next|下一页|下页|下一章|下一篇|下一回|下一节|下章|continue|下一篇)/i;

export function detectNextPage(
  doc: Document,
  currentUrl: string,
  visitedUrls: Iterable<string> = []
): NextPageCandidate | undefined {
  const visited = new Set(Array.from(visitedUrls, normalizeForCompare));
  visited.add(normalizeForCompare(currentUrl));

  const relLink = doc.querySelector<HTMLLinkElement>('link[rel~="next"][href]');
  const relLinkUrl = normalizeCandidateUrl(relLink?.getAttribute('href'), currentUrl, visited);
  if (relLinkUrl) {
    return {
      url: relLinkUrl,
      source: 'link-rel',
      score: 100,
      label: relLink?.getAttribute('href') ?? relLinkUrl
    };
  }

  const candidates: NextPageCandidate[] = [];
  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!isVisibleEnough(anchor)) {
      continue;
    }

    const url = normalizeCandidateUrl(anchor.getAttribute('href'), currentUrl, visited);
    if (!url) {
      continue;
    }

    const text = normalizeText(anchor.textContent ?? '');
    const title = anchor.getAttribute('title') || '';
    const attributes = normalizeText(
      [
        anchor.getAttribute('aria-label'),
        title,
        anchor.getAttribute('class'),
        anchor.getAttribute('id'),
        anchor.getAttribute('rel')
      ]
        .filter(Boolean)
        .join(' ')
    );

    if (/\bnext\b/i.test(anchor.rel)) {
      candidates.push({ url, source: 'anchor-rel', score: 95, label: text || attributes || url });
      continue;
    }

    const textMatched = TEXT_PATTERNS.some((pattern) => pattern.test(text));
    if (textMatched) {
      candidates.push({ url, source: 'anchor-text', score: sameOriginBoost(url, currentUrl, 80), label: text || url });
      continue;
    }

    if (ATTRIBUTE_PATTERN.test(attributes)) {
      let score = 60;
      // 如果 title 中明确包含下一页/下一篇关键词，额外加分
      if (/下一篇|下一章|下一页|next/i.test(title)) {
        score += 10;
      }
      candidates.push({
        url,
        source: 'anchor-attribute',
        score: sameOriginBoost(url, currentUrl, score),
        label: text || attributes || url
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function normalizeCandidateUrl(
  rawUrl: string | undefined | null,
  currentUrl: string,
  visited: Set<string>
): string | undefined {
  if (!rawUrl) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, currentUrl);
  } catch {
    return undefined;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return undefined;
  }

  const current = new URL(currentUrl);
  if (parsed.origin === current.origin && parsed.pathname === current.pathname && parsed.search === current.search) {
    return undefined;
  }

  parsed.hash = '';
  const normalized = parsed.toString();
  if (visited.has(normalizeForCompare(normalized))) {
    return undefined;
  }

  return normalized;
}

function normalizeForCompare(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function sameOriginBoost(url: string, currentUrl: string, baseScore: number): number {
  try {
    return new URL(url).origin === new URL(currentUrl).origin ? baseScore + 8 : baseScore;
  } catch {
    return baseScore;
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isVisibleEnough(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const style = element.getAttribute('style') ?? '';
  return !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}
