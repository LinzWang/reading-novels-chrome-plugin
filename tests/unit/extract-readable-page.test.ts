import { describe, expect, it } from 'vitest';
import { createTextSegments, extractReadablePage, splitIntoSentences } from '../../src/content/extract-readable-page';

function html(source: string, url = 'https://example.com/article/1'): Document {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  Object.defineProperty(doc, 'URL', { value: url });
  return doc;
}

describe('splitIntoSentences', () => {
  it('splits long Chinese paragraphs into sentence-sized segments', () => {
    expect(splitIntoSentences('这是第一句。这是第二句！这是第三句？')).toEqual(['这是第一句。', '这是第二句！', '这是第三句？']);
  });
});

describe('createTextSegments', () => {
  it('creates stable text segments from readable blocks', () => {
    const doc = html('<main><h2>小标题</h2><p>第一段内容。</p><p>第二段内容。</p></main>');
    const segments = createTextSegments(doc.querySelector('main')!, '标题');
    expect(segments.map((segment) => segment.text)).toEqual(['标题', '小标题', '第一段内容。', '第二段内容。']);
    expect(segments.map((segment) => segment.id)).toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3']);
  });
});

describe('extractReadablePage', () => {
  it('extracts a readable fallback page model', () => {
    const doc = html(`
      <html lang="zh-CN">
        <head><title>测试文章</title></head>
        <body>
          <main>
            <p>这是一段足够长的正文，用来模拟阅读模式提取。</p>
            <p>这是第二段正文。</p>
            <a href="/article/2">下一页</a>
          </main>
        </body>
      </html>
    `);
    const page = extractReadablePage(doc, { url: 'https://example.com/article/1' });
    expect(page.title).toBe('测试文章');
    expect(page.lang).toBe('zh-CN');
    expect(page.textSegments.length).toBeGreaterThan(1);
    expect(page.nextUrl).toBe('https://example.com/article/2');
    expect(page.contentHtml).toContain('data-segment-id="seg-0"');
  });
});
