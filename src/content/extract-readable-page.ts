import { Readability } from '@mozilla/readability';
import DOMPurify from 'dompurify';
import type { PageModel, TextSegment } from '../shared/page-model';
import { detectNextPage } from './next-page-detector';

export interface ExtractReadablePageOptions {
  url?: string;
  visitedUrls?: Iterable<string>;
}

interface ReadabilityResultLike {
  title?: string;
  byline?: string;
  dir?: string;
  lang?: string;
  content?: string;
  textContent?: string;
  excerpt?: string;
}

export function extractReadablePage(doc: Document, options: ExtractReadablePageOptions = {}): PageModel {
  const url = options.url ?? doc.URL ?? globalThis.location?.href ?? 'about:blank';
  const parsed = new Readability(doc.cloneNode(true) as Document).parse() as ReadabilityResultLike | null;
  const fallbackElement = findFallbackContainer(doc);
  const rawHtml = parsed?.content?.trim() || fallbackElement?.innerHTML || doc.body?.innerHTML || '';
  const title = parsed?.title?.trim() || doc.title || '未命名页面';
  const lang = parsed?.lang || doc.documentElement.lang || undefined;
  const sanitized = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'data-limit', 'data-hide']
  });

  const template = doc.createElement('template');
  template.innerHTML = sanitized;
  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote';

  // 原文档保存元素引用，我们需要去原文档检查元素是否真的被隐藏了
  // 因为 template.content 在内存中，getComputedStyle 拿不到应用后的 CSS 结果
  const originalElements = new WeakMap<Node, HTMLElement | null>();
  if (doc === document) {
    // 如果是当前页面文档，遍历模板块，按顺序匹配原文档元素
    // HTML 结构顺序不会变，顺序匹配就正确
    const originalBlocks = Array.from(doc.querySelectorAll(blockSelector));
    const templateBlocks = Array.from(template.content.querySelectorAll(blockSelector));

    let origIdx = 0;
    for (const templateBlock of templateBlocks) {
      // 跳过原文档中已经隐藏的，因为模板里也不会有它们（Readability 过滤？不一定，所以继续匹配）
      while (origIdx < originalBlocks.length && isElementHiddenOrWatermark(originalBlocks[origIdx])) {
        origIdx++;
      }
      if (origIdx < originalBlocks.length) {
        originalElements.set(templateBlock, originalBlocks[origIdx]);
        origIdx++;
      }
    }
  }

  rebaseUrls(template.content, url);

  const textSegments = createTextSegments(template.content, title, originalElements);
  const contentHtml = renderSegmentsAsHtml(textSegments);
  const nextUrl = detectNextPage(doc, url, options.visitedUrls)?.url;

  return {
    url,
    title,
    byline: parsed?.byline || undefined,
    lang,
    excerpt: parsed?.excerpt || undefined,
    contentHtml,
    textSegments,
    nextUrl
  };
}

export function createTextSegments(root: ParentNode, title?: string, originalElements?: WeakMap<Node, HTMLElement | null>): TextSegment[] {
  const segments: TextSegment[] = [];
  let index = 0;

  const push = (text: string, kind: TextSegment['kind']) => {
    const normalized = normalizeWhitespace(text);
    if (!normalized) {
      return;
    }

    // 修正多音字得到朗读用文本
    const speechText = fixPolyphonicWords(normalized);
    // 如果修正和原文不同，保存两份，显示用原文，朗读用修正
    const hasFix = speechText !== normalized;

    if (kind === 'paragraph') {
      // 如果分段拆分句子，每个句子单独处理
      const sentences = splitIntoSentences(normalized);
      if (sentences.length > 1) {
        for (const sentence of sentences) {
          const fixedSentence = fixPolyphonicWords(sentence);
          if (fixedSentence !== sentence) {
            segments.push({ id: `seg-${index++}`, text: sentence, speechText: fixedSentence, kind: 'sentence' });
          } else {
            segments.push({ id: `seg-${index++}`, text: sentence, kind: 'sentence' });
          }
        }
        return;
      }
    }

    if (hasFix) {
      segments.push({ id: `seg-${index++}`, text: normalized, speechText, kind });
    } else {
      segments.push({ id: `seg-${index++}`, text: normalized, kind });
    }
  };

  // 标题已经在阅读模式顶部单独渲染了，这里不需要再添加重复的标题段
  // 只需要处理正文块，正文里的重复标题会被检测跳过

  const blockSelector = 'h1,h2,h3,h4,h5,h6,p,li,blockquote';
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(blockSelector));
  if (blocks.length === 0) {
    push(root.textContent ?? '', 'paragraph');
  } else {
    let foundFirstContent = false;
    let hasAnyContent = false;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // 如果我们保存了原文档元素引用，用原元素检查是否隐藏
      // 因为当前在内存模板中，getComputedStyle 拿不到真实 CSS 结果
      let needSkip = false;
      if (originalElements) {
        const original = originalElements.get(block);
        if (original && isElementHiddenOrWatermark(original)) {
          needSkip = true;
        }
      } else if (isElementHiddenOrWatermark(block)) {
        needSkip = true;
      }

      if (needSkip) {
        continue;
      }

      const text = normalizeWhitespace(block.textContent ?? '');

      if (!text) {
        // 跳过空块，继续找第一个非空
        continue;
      }

      // 如果文本内容包含常见版权/推广关键词，即使没隐藏也跳过（防盗水印）
      const lowerText = text.toLowerCase();
      if (text.length < 80 && (
        lowerText.includes('首发') ||
        lowerText.includes('塔读') ||
        (lowerText.includes('app') && lowerText.includes('小说')) ||
        lowerText.includes('vip') ||
        lowerText.includes('会员') ||
        lowerText.includes('无广告') ||
        lowerText.includes('免费阅读') ||
        lowerText.includes('本书由') ||
        lowerText.includes('本站首发') ||
        lowerText.includes('txt下载') ||
        lowerText.includes('请记住') ||
        lowerText.includes('手机看')
      )) {
        continue;
      }

      // 需要跳过的情况：
      // 1. 第一个非空块看起来像是章节标题（和顶部标题重复）→ 跳过
      // 2. 任何块，如果内容和页面标题相似 → 跳过（正文重复放置完整标题）
      // 3. 任何块本身能被识别为章节标题 → 跳过（已经有标题了）
      const needSkipTitle =
        (!foundFirstContent && title && isChapterTitle(text)) ||
        (title && isTitleSimilar(text, title)) ||
        (title && isChapterTitle(text));

      if (needSkipTitle) {
        foundFirstContent = foundFirstContent || true;
        continue;
      }

      foundFirstContent = true;
      hasAnyContent = true;
      const tag = block.tagName.toLowerCase();
      const kind: TextSegment['kind'] = tag.startsWith('h')
        ? 'heading'
        : tag === 'li'
          ? 'list-item'
          : tag === 'blockquote'
            ? 'blockquote'
            : 'paragraph';
      push(block.textContent ?? '', kind);
    }

    // 如果所有块都被跳过了（只有一个标题块被跳过），回退到整个内容
    if (!hasAnyContent) {
      push(root.textContent ?? '', 'paragraph');
    }
  }

  let processedSegments = dedupeNearbySegments(segments);

  // 移除末尾类似"本章完"、"完"等占位文本
  processedSegments = removeTrailingPlaceholders(processedSegments);

  // 过滤掉只有标点符号/引号的极短段落，并合并到相邻段落避免单独成行
  processedSegments = mergeTinySegments(processedSegments);

  return processedSegments;
}

/** 移除末尾类似"本章完"、"完"等占位文本 */
function removeTrailingPlaceholders(segments: TextSegment[]): TextSegment[] {
  if (segments.length === 0) return segments;

  const placeholderPattern = /^(本章完|完|全文完|结束|正文完|下一章|下一章节|下期再见)$/i;
  let lastIndex = segments.length - 1;

  // 从末尾往前找，移除所有占位短文本
  while (lastIndex >= 0) {
    const seg = segments[lastIndex];
    if (seg.text.length <= 6 && placeholderPattern.test(seg.text.trim())) {
      lastIndex--;
    } else {
      break;
    }
  }

  if (lastIndex < 0) {
    return segments;
  }
  return segments.slice(0, lastIndex + 1);
}

/** 检测文本是否看起来像是章节标题 */
function isChapterTitle(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim();

  // 1. 匹配: 第X章、第X回、第X节、第X篇、第X卷，X可以是中文数字或阿拉伯数字
  const chapterPattern = /^第\s*[一二三四五六七八九十百零0-9]+\s*[章回节篇卷]/;
  if (chapterPattern.test(normalized)) {
    return true;
  }

  // 2. 匹配: 书名 + 章节名 + 网站名 格式，如 "第二章 404号避难所《这游戏也太真实了》- 顶点小说网"
  // 或 "《书名》 第X章 标题 - 网站"
  const bookSitePattern = /[《【\[].+[》】]/;
  if (bookSitePattern.test(normalized) && (chapterPattern.test(normalized) || /[-–—]\s*\w+小说网|website$/i.test(normalized))) {
    return true;
  }

  // 3. 匹配: 结尾有网站标识，如 "XXX - 顶点小说网"
  const siteSuffixPattern = /[-–—]\s*.*(小说网|顶点|起点|书旗|晋江|起点|中文网|小说阅读网|阅读器)/i;
  if (siteSuffixPattern.test(normalized) && normalized.length < 60) {
    return true;
  }

  // 4. 一整行只有章节标题 + 书名 + 网站，长度较短且包含分隔符，也判定为标题
  // 例如 "第二章 404号避难所《这游戏也太真实了》- 顶点小说网"
  if (normalized.includes('-') && normalized.length < 100 && (normalized.match(/第.*[章回]/) || bookSitePattern.test(normalized) || siteSuffixPattern.test(normalized))) {
    return true;
  }

  // 5. 纯 "小说名 - 章节名 - 网站" 格式，也判定
  if ((normalized.match(/[-–—]/g) || []).length >= 1 && normalized.length < 100 && siteSuffixPattern.test(normalized)) {
    return true;
  }

  return false;
}

/** 检测正文标题是否和页面标题重复，如果相似就跳过，避免重复显示 */
function isTitleSimilar(blockText: string, pageTitle: string): boolean {
  const blockNorm = blockText.toLowerCase().trim();
  const titleNorm = pageTitle.toLowerCase().trim();

  // 完全匹配 → 肯定重复
  if (blockNorm === titleNorm) {
    return true;
  }

  // 一个包含另一个 → 也说明是重复标题
  if (blockNorm.includes(titleNorm) || titleNorm.includes(blockNorm)) {
    // 长度比足够大才认为是重复，避免误判
    const ratio = Math.min(blockNorm.length, titleNorm.length) / Math.max(blockNorm.length, titleNorm.length);
    return ratio > 0.5; // 一半长度以上重叠，认为是重复
  }

  return false;
}

export function splitIntoSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const matches = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [normalized];
  const sentences = matches.map((part) => part.trim()).filter(Boolean);
  return sentences.length > 0 ? sentences : [normalized];
}

function findFallbackContainer(doc: Document): Element | undefined {
  // 优先通过常见小说阅读内容容器类名找
  const novelSelectors = [
    // 常见小说阅读内容容器
    '[class*="content"]',
    '[class*="Content"]',
    '[id*="content"]',
    '[id*="Content"]',
    '[class*="text"]',
    '[class*="Text"]',
    '[id*="text"]',
    '[id*="Text"]',
    '[class*="body"]',
    '[class*="Body"]',
    '[class*="article"]',
    '[id*="article"]',
    '.reader-content',
    '.chapter-content',
    '#chapter-content',
    '.read-content',
    '.novel-content',
    '.book-content',
    '.main-box',
    '.content-box',
    'article',
    'main',
    '[role="main"]'
  ];

  for (const selector of novelSelectors) {
    const element = doc.querySelector(selector);
    if (element && element.textContent && normalizeWhitespace(element.textContent).length > 200) {
      // 找到内容足够长的容器
      return element;
    }
  }

  const direct = doc.querySelector('article, main, [role="main"]');
  if (direct) {
    return direct;
  }

  const candidates = Array.from(doc.body?.querySelectorAll<HTMLElement>('section, div') ?? []);
  return candidates
    .map((element) => ({ element, score: element.querySelectorAll('p').length * 10 + normalizeWhitespace(element.textContent ?? '').length }))
    .sort((a, b) => b.score - a.score)[0]?.element;
}

function rebaseUrls(root: ParentNode, baseUrl: string): void {
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    anchor.href = new URL(anchor.getAttribute('href') ?? '', baseUrl).toString();
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
  }

  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    image.src = new URL(image.getAttribute('src') ?? '', baseUrl).toString();
  }
}

function renderSegmentsAsHtml(segments: TextSegment[]): string {
  return segments
    .map((segment) => {
      const text = escapeHtml(segment.text);
      const tag = segment.kind === 'title' || segment.kind === 'heading' ? 'h2' : segment.kind === 'blockquote' ? 'blockquote' : 'p';
      return `<${tag} class="reader-segment" data-segment-id="${segment.id}">${text}</${tag}>`;
    })
    .join('\n');
}

function dedupeNearbySegments(segments: TextSegment[]): TextSegment[] {
  const result: TextSegment[] = [];
  for (const segment of segments) {
    if (result[result.length - 1]?.text === segment.text) {
      continue;
    }
    result.push({ ...segment, id: `seg-${result.length}` });
  }
  return result;
}

/** 过滤并合并只有引号/标点的极短段落，避免单独成行 */
function mergeTinySegments(segments: TextSegment[]): TextSegment[] {
  if (segments.length === 0) return segments;

  const result: TextSegment[] = [];

  for (const segment of segments) {
    const text = segment.text.trim();

    // 检查是否只是引号或标点的极短段
    const isTinyPunctuation = text.length <= 2 && /^[“”" '‘’「」『』《》（）()，,。.、！!?？；:：—–—-………]+$/.test(text);

    if (isTinyPunctuation) {
      // 如果是极短标点段，合并到最后一个段落
      if (result.length > 0) {
        result[result.length - 1].text += text;
      }
      // 如果是第一个段落就是这个，直接丢弃（不太可能发生）
      continue;
    }

    // 如果上一个段落很短且不是标题，可以考虑合并？
    // 但保持原kind分类，只合并文本
    result.push({ ...segment });
  }

  // 重新分配id
  return result.map((seg, idx) => ({ ...seg, id: `seg-${idx}` }));
}

/** 常见多音字修正，引导语音引擎读正确发音 */
function fixPolyphonicWords(text: string): string {
  // 针对文章中的常见多音字场景做替换
  // 显示给用户看的仍然是原文字，替换只发生在朗读文本
  let fixed = text
    // ===== 行: háng (行数) vs xíng (行走) =====
    // 每一行 / 一行 / 第一行 / 下一行 / 上一行 / 这一行 / 那一行 / 第几行
    .replace(/([每第上下这那])一?行/g, '$1一航')
    // XX行 (行数)
    .replace(/(\d+)行/g, '$1航')
    // 行高 / 行间距 / 行宽 / 行距
    .replace(/行([高距宽距])/g, '航$1')
    // 第几行
    .replace(/第.*行\b/g, (match) => match.replace(/行$/, '航'))
    // ===== 好: hào (喜好) vs hǎo (好坏) =====
    .replace(/喜好/g, '喜号')
    .replace(/爱好/g, '爱号')
    .replace(/好[恶憎]/g, '号$1')
    // ===== 长: cháng (长度) vs zhǎng (生长) =====
    .replace(/长([度短径方形])/g, '常$1')
    .replace(/([身增成生])长/g, '$1涨')
    // ===== 重: chóng (重复) vs zhòng (重量) =====
    .replace(/重([复新叠逢])/g, '虫$1')
    .replace(/([沉加严加稳体]重)/g, '$1种')
    // ===== 都: dū (首都) vs dōu (全都) =====
    .replace(/首都/g, '首嘟')
    .replace(/成都/g, '成嘟')
    // ===== 处: chǔ (处理) vs chù (到处) =====
    .replace(/([接审办受]理)/g, '楚$1')
    .replace(/处([理])/g, '楚$1')
    .replace(/处([罚分])/g, '楚$1')
    // ===== 觉: jiào (睡觉) vs jué (感觉) =====
    .replace(/睡觉/g, '睡叫')
    // ===== 和: huó (和面) vs hé (和平) =====
    .replace(/和面/g, '活面')
    // ===== 发: fā (发现) vs fà (头发) =====
    .replace(/([头理]发)/g, '$1珐')
    // ===== 否: fǒu (否定) vs pǐ (否极泰来) =====
    // 不常见，跳过
    // ===== 分: fēn (分开) vs fèn (成分) =====
    .replace(/([身成过部]分)/g, '$1奋')
    // ===== 冠: guān (皇冠) vs guàn (冠军) =====
    .replace(/冠军/g, '灌军')
    // ===== 喝: hē (喝水) vs hè (喝彩) =====
    .replace(/喝([彩倒])/g, '赫$1')
    // ===== 奇: qí (奇怪) vs jī (奇数) =====
    .replace(/奇数/g, '机数')
    // ===== 解: jiě (解决) vs xiè (解数) =====
    // 不常见跳过
    // ===== 禁: jīn (禁受) vs jìn (禁止) =====
    .replace(/禁([止闭])/g, '进$1')
    .replace(/([情不自]禁)/g, '$1今')
    // ===== 尽: jǐn (尽管) vs jìn (尽力) =====
    .replace(/([力尽心]尽)/g, '$1进')
    // ===== 卷: juǎn (卷起) vs juàn (试卷) =====
    .replace(/([试考画文]卷)/g, '$1眷')
    // ===== 卡: qiǎ (卡片) vs kǎ (卡车) - 其实卡qiǎ才对，引擎经常读错 =====
    .replace(/卡([片通])/g, '恰$1')
    // ===== 看: kān (看门) vs kàn (看见) =====
    .replace(/看([门守])/g, '刊$1')
    // ===== 空: kōng (空气) vs kòng (空闲) =====
    .replace(/([闲]空)/g, '$1控')
    // ===== 乐: lè (快乐) vs yuè (音乐) =====
    .replace(/([音奏]乐)/g, '$1岳')
    // ===== 累: lèi (劳累) vs lěi (积累) =====
    .replace(/([积]累)/g, '$1垒')
    .replace(/累([计])/g, '垒$1')
    // ===== 量: liáng (测量) vs liàng (重量) =====
    .replace(/([重力数]量)/g, '$1亮')
    // ===== 模: mó (模型) vs mú (模样) =====
    .replace(/模([样])/g, '膜$1')
    // ===== 难: nán (困难) vs nàn (灾难) =====
    .replace(/灾[难]/g, '灾叹')
    // ===== 喷: pēn (喷泉) vs pèn (喷香) =====
    // 场景少跳过
    // ===== 劈: pī (劈刀) vs pǐ (劈叉) - 跳过
    // ===== 漂: piāo (漂流) vs piào (漂亮) =====
    .replace(/漂[亮]/g, '票亮')
    // ===== 便: biàn (方便) vs pián (便宜) =====
    .replace(/便[宜]/g, '骈宜')
    // ===== 铺: pū (铺床) vs pù (店铺) =====
    .replace(/([店]铺)/g, '$1瀑')
    // ===== 强: qiáng (强大) vs qiǎng (强迫) vs jiàng (倔强) =====
    .replace(/强([迫逼])/g, '抢$1')
    // ===== 翘: qiào (翘尾巴) vs qiáo (翘首) =====
    .replace(/翘([尾巴])/g, '窍$1')
    // ===== 曲: qū (弯曲) vs qǔ (歌曲) =====
    .replace(/([歌]曲)/g, '$1取')
    // ===== 任: rèn (任务) vs rén (姓任) =====
    // 跳过
    // ===== 散: sǎn (松散) vs sàn (分散) =====
    .replace(/散([布发])/g, '算$1')
    // ===== 少: shǎo (多少) vs shào (少年) =====
    .replace(/([少]年)/g, '绍$1')
    // ===== 舍: shě (舍弃) vs shè (宿舍) =====
    .replace(/([宿]舍)/g, '$1社')
    // ===== 盛: chéng (盛饭) vs shèng (盛开) =====
    .replace(/盛([饭])/g, '成$1')
    // ===== 数: shǔ (数数) vs shù (数字) =====
    .replace(/数([一数])/g, '蜀$1')
    // ===== 似: sì (相似) vs shì (似的) =====
    // 引擎一般读对，跳过
    // ===== 踏: tā (踏实) vs tà (踏步) =====
    .replace(/踏[实]/g, '塌实')
    // ===== 挑: tiāo (挑水) vs tiǎo (挑战) =====
    .replace(/挑([战])/g, '眺$1')
    // ===== 吐: tǔ (吐痰) vs tù (呕吐) =====
    .replace(/呕[吐]/g, '呕兔')
    // ===== 为: wéi (成为) vs wèi (因为) =====
    // 引擎一般读对，跳过
    // ===== 系: xì (关系) vs jì (系鞋带) =====
    .replace(/系([鞋带])/g, '记$1')
    // ===== 吓: xià (吓人) vs hè (恐吓) =====
    .replace(/恐[吓]/g, '恐赫')
    // ===== 相: xiāng (相互) vs xiàng (相貌) =====
    .replace(/相([貌])/g, '象$1')
    // ===== 血: xiě (血淋淋) vs xuè (血液) =====
    // 口语书面区别，不处理
    // ===== 殷: yīn (殷勤) vs yān (殷红) =====
    .replace(/殷[红]/g, '嫣红')
    // ===== 应: yīng (应该) vs yìng (答应) =====
    .replace(/应([答对])/g, '映$1')
    .replace(/([答供]应)/g, '$1映')
    // ===== 载: zǎi (记载) vs zài (载重) =====
    .replace(/载([重])/g, '在$1')
    // ===== 涨: zhǎng (涨潮) vs zhàng (涨大) - 跳过，区别不大
    // ===== 折: zhé (折断) vs shé (折本) =====
    .replace(/折[本]/g, '舌本')
    // ===== 挣: zhēng (挣扎) vs zhèng (挣脱) =====
    .replace(/挣([脱])/g, '正$1')
    // ===== 钻: zuān (钻探) vs zuàn (钻石) =====
    .replace(/钻([石])/g, '赞$1')
    // ===== 着: zhuó (着陆) vs zháo (着急) =====
    .replace(/着([陆])/g, '卓$1')
    .replace(/着([急])/g, '招$1')
    // ===== 脏: zāng (肮脏) vs zàng (内脏) =====
    .replace(/([内]脏)/g, '$1葬')
    return fixed;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 检查元素本身或任何祖先元素是否被隐藏 / 有防盗标记 */
function isElementHiddenOrWatermark(el: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current) {
    // 网站标记防盗文字的自定义属性，直接跳过
    if (current.hasAttribute('data-limit') || current.hasAttribute('data-hide')) {
      return true;
    }
    // CSS 隐藏
    const computed = getComputedStyle(current);
    if (
      computed.display === 'none' ||
      computed.visibility === 'hidden' ||
      parseFloat(computed.opacity) === 0 ||
      (parseFloat(computed.height) <= 0 && current.clientHeight <= 0) ||
      parseFloat(computed.fontSize) <= 0
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
