import { describe, expect, it } from 'vitest';
import { detectNextPage } from '../../src/content/next-page-detector';

function html(source: string): Document {
  return new DOMParser().parseFromString(source, 'text/html');
}

describe('detectNextPage', () => {
  it('prefers link rel=next', () => {
    const doc = html('<link rel="next" href="/page/2"><a href="/wrong">下一页</a>');
    expect(detectNextPage(doc, 'https://example.com/page/1')?.url).toBe('https://example.com/page/2');
  });

  it('detects Chinese next-page anchors', () => {
    const doc = html('<a href="chapter-2.html">下一章</a>');
    expect(detectNextPage(doc, 'https://example.com/book/chapter-1.html')?.url).toBe(
      'https://example.com/book/chapter-2.html'
    );
  });

  it('detects English next anchors', () => {
    const doc = html('<a href="?page=2">Next</a>');
    expect(detectNextPage(doc, 'https://example.com/articles?page=1')?.url).toBe('https://example.com/articles?page=2');
  });

  it('rejects unsafe and visited URLs', () => {
    const doc = html('<a href="javascript:alert(1)">下一页</a><a href="/page/1">Next</a>');
    expect(detectNextPage(doc, 'https://example.com/page/1', ['https://example.com/page/1'])).toBeUndefined();
  });
});
