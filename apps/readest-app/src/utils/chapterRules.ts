// ---------------------------------------------------------------------------
// 章节标题规则表（方向②：规则数据化，便于扩展新语言 / 新格式）。
// 每种语言是一组 chapter 正则（按顺序构成 fallback 链，第一条"切得合格"即胜出）。
// 没有专门规则的语言回退到 '*'（通用英文规则），行为与旧"非 zh 走英文"一致。
// 'source' 为完整 RegExp source（含行首锚点与捕获组），'flags' 为标志位。
// ---------------------------------------------------------------------------
export interface ChapterRule {
  source: string;
  flags: string;
}

export const ZH_NUMBER =
  '第[ 　零〇一二三四五六七八九十0-9][ 　零〇一二三四五六七八九十百千万0-9]*';
export const ZH_CHAPTER_UNIT = String.raw`[章节回讲篇话](?:[：:、 　\(\)0-9]*[^\n-]{0,36})`;
export const ZH_VOLUME_UNIT = String.raw`[卷本册部封](?:[：:、 　\(\)][：:、 　\(\)0-9]*[^\n-]{0,36})?`;

const EN_NUMBER = String.raw`(?:\d+|(?:[IVXLCDM]{2,}|V|X|L|C|D|M)\b)`;
const EN_DOT_NUMBER = String.raw`\.\d{1,4}`;
const EN_TITLE = String.raw`[^\n]{0,50}`;
const EN_NORMAL = ['Chapter', 'Part', 'Section', 'Book', 'Volume', 'Act']
  .map((k) => String.raw`${k}\s*(?:${EN_NUMBER}|${EN_DOT_NUMBER})(?:[:.\-–—]?\s*${EN_TITLE})?`)
  .join('|');
const EN_PREFACE = ['Prologue', 'Epilogue', 'Introduction', 'Foreword', 'Preface', 'Afterword']
  .map((k) => String.raw`${k}(?:[:.\-–—]?\s*${EN_TITLE})?`)
  .join('|');

const EN_RULES: ChapterRule[] = [
  {
    source: String.raw`(?:^|\n)(${EN_NORMAL}|${EN_PREFACE})(?=\s|$)`,
    flags: 'gi',
  },
  {
    // 裸编号标题：1.1The Elements / 1Building Data（单数字要求标题紧跟，避开脚注）
    source: String.raw`(?:^|\n)(\d+\.\d+(?:\.\d+)* ?[A-Z][^\n]{0,80}|\d+[A-Z][^\n]{0,80})`,
    flags: 'g',
  },
];

export const CHAPTER_RULES: Record<string, ChapterRule[]> = {
  zh: [
    {
      // 第N章/节/回/讲/篇/话 + 第N卷/本/册/部/封 + 前言类 + 英文式 chapter N。
      // 卷/册等单位要求标题由分隔符或行尾引入，避免"第一本书"被误当标题（#4658）。
      // 标题前允许可选【】包裹（【...】），避免带方括号的章节被整条漏掉。
      source:
        String.raw`(?:^|\n)\s*(?:【)?(` +
        [
          String.raw`${ZH_NUMBER}(?:${ZH_CHAPTER_UNIT}|${ZH_VOLUME_UNIT})(?!\S)`,
          String.raw`(?:楔子|前言|简介|引言|序言|序章|总论|概论|后记|番外篇|番外|外传)(?:[：: 　][^\n-]{0,36})?(?:】)?(?!\S)`,
          String.raw`chapter[\s.]*[0-9]+(?:[：:. 　]+[^\n-]{0,50})?(?!\S)`,
        ].join('|') +
        ')',
      flags: 'gui',
    },
    {
      // 第二级：中文序数词开头行，或纯数字编号行（同样容忍【】前缀）。
      // 注意必须只保留外层一个捕获组：String.split 会为每个捕获组各插入
      // 一个元素，多余嵌套组会使 extractChaptersFromSegment 的 j += 2 配对
      // 全面错位（标题重复进正文、正文行变标题）。
      source:
        String.raw`(?:^|\n)\s*(?:【)?(` +
        [
          String.raw`[一二三四五六七八九十][零〇一二三四五六七八九十百千万]?[：:、 　][^\n-]{0,36}(?=\n|$)`,
          String.raw`[0-9]+[^\n]{0,16}(?=\n|$)`,
        ].join('|') +
        ')',
      flags: 'gu',
    },
  ],
  ja: [
    {
      // 第X話/章/巻/編/節 + 序章/前/后言
      source: String.raw`(?:^|\n)\s*(第[０-９0-9一二三四五六七八九十百千]+(?:話|章|巻|編|節)(?:[：:、 　][^\n-]{0,40})?(?!\S)|(?:序章|プロローグ|エピローグ|あとがき))`,
      flags: 'u',
    },
    EN_RULES[1]!,
  ],
  ko: [
    {
      // 제X장/권/편/막 + 서장/프롤로그/에필로그
      source: String.raw`(?:^|\n)\s*(제\s*[0-9一二三四五六七八九十百]+(?:장|권|편|막)(?:[：:、 　][^\n-]{0,40})?(?!\S)|(?:서장|프롤로그|에필로그))`,
      flags: 'u',
    },
    EN_RULES[1]!,
  ],
  en: EN_RULES,
  '*': EN_RULES,
};

// 用户输入进构造正则的路径，`new RegExp` 只捕语法错误、不防灾难性回溯
// （catastrophic backtracking）：病态正则如 (a+)+ 在长文本上是指数回溯。
// 这里做启发式守门（宁可放过不明显病态、也不误伤正常规则），超限的规则
// 拒用并返回原因。返回空数组=可安全使用。
const REDOS_PATTERN_LENGTH_LIMIT = 512;
const REDOS_PATTERN_MAX_DEPTH = 4;

export const validateChapterPattern = (pattern: string): string[] => {
  const problems: string[] = [];
  if (pattern.length > REDOS_PATTERN_LENGTH_LIMIT) {
    problems.push(`超过长度上限 ${REDOS_PATTERN_LENGTH_LIMIT} 字符`);
    return problems;
  }
  // 分组嵌套深度（跳过转义与字符类内的括号）。
  let depth = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      while (i < pattern.length && pattern[i] !== ']') i++;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      if (depth > REDOS_PATTERN_MAX_DEPTH) {
        problems.push(`分组嵌套过深（>${REDOS_PATTERN_MAX_DEPTH} 层）`);
        break;
      }
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    }
    i++;
  }
  if (problems.length > 0) return problems;
  // 捕获组契约（B-8）：用户每项规则会被外层再包一个捕获组
  // `(?:^|\n)\s*(${pattern})`，内含捕获组会让章节 split 的双捕获语义错位、
  // 全 TOC 损坏。用户规则不得携带捕获组（非捕获 `(?:`/环视 `(?=` 等除外）。
  {
    let j = 0;
    while (j < pattern.length) {
      const c = pattern[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') {
        while (j < pattern.length && pattern[j] !== ']') j++;
        j++;
        continue;
      }
      if (c === '(') {
        const rest = pattern.slice(j + 1);
        const isNonCapturing = /^\?(:|=|!|<=|<!)/.test(rest);
        if (!isNonCapturing) {
          problems.push('不允许包含捕获组（章节规则只接受无捕获组的正则）');
          return problems;
        }
      }
      j++;
    }
  }
  // 嵌套量词链：一对不含嵌套括号的组内含量词、且闭组后又跟量词，是灾难性
  // 回溯的高发形态（(a+)+、(?:\\d+|x)* 等）。量词含区间形态 {n,m}——只认
  // 单字符量词会漏掉 (a+){20}、（?:\d+）{10} 这类炸弹，须一并拦截。
  if (/\([^()]*[+*?][^()]*\)(?:[+*?]|\{\d+(?:,\d+)?\})/.test(pattern)) {
    problems.push('检测到可能灾难性回溯的嵌套量词');
  }
  return problems;
};

// ---------------------------------------------------------------------------
// 引导式章节识别："候选标题行"提取 + 勾选行 → 识别规则生成。
// buildChapterRegexps 会把生成的 pattern 再包行锚/捕获组并置于内置规则之前，
// 所以这里返回的 pattern 只需匹配"标题行内容"。
// ---------------------------------------------------------------------------
// 候选标题行特征：行首必须是标题引导字，且整行不跨行长（行长过滤由上方
// s.length>40 处理）。曾用 `|章|回|更|卷|部|話` 的任意位置单字分支，会把
// "本章说：感谢打赏""更新说明：作者有话说""下部预告"这类正文行误作标题——
// 短正文行密集的书里 40 个候选名额会被正文占满。
export const CHAPTER_CANDIDATE_TITLE_RX = /^[第卷回楔序【後记终扉][^\n]{0,40}$/;

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isNumChar = (ch: string): boolean =>
  ch.length > 0 && /[0-9零〇一二三四五六七八九十百千万]/.test(ch);

export const NUM_WILDCARD = '[0-9零〇一二三四五六七八九十百千万]+';

export const buildChapterPatternFromSamples = (samples: string[]): string | null => {
  const trimmed = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.length === 0) return null;

  const first = trimmed[0]!;
  let out = '';
  let i = 0;
  // 贪心对齐公共前缀：字符一致则保留（数字区段统一通配化，覆盖"第X章"里
  // 递增的数字）；首个字符即非数字分歧 → 放弃对齐，退化为字面量 alternation。
  while (i < first.length) {
    const ch = first[i]!;
    const allSame = trimmed.every((s) => s[i] === ch);
    if (allSame) {
      if (isNumChar(ch)) {
        out += NUM_WILDCARD;
        while (i < first.length && trimmed.every((s) => isNumChar(s[i] ?? ''))) i++;
        continue;
      }
      out += escapeRegExp(ch);
      i++;
    } else if (trimmed.every((s) => isNumChar(s[i] ?? ''))) {
      out += NUM_WILDCARD;
      while (i < first.length && trimmed.every((s) => isNumChar(s[i] ?? ''))) i++;
    } else {
      break;
    }
  }

  // 尾段通配给长度上限：无界 [^\n]* 会把"数字+点"开头的超长正文行整句吞成
  // 章节标题。60 足以覆盖典型章节标题长度，同时收窄误伤面。
  if (out.length >= 2) return `${out}[^\\n]{0,60}`;
  if (trimmed.length <= 40) return trimmed.map((s) => escapeRegExp(s)).join('|');
  return null;
};

// 同一语言+用户规则在整本转换的每个 segment 都会重建，跨实例缓存
// 复用（worker 每次转换新建实例）；上限 32 组，LRU 淘汰最旧。
const CHAPTER_REGEXP_CACHE_MAX = 32;
// 缓存已验证的规则源而非 RegExp 实例：RegExp 是带 lastIndex 的有状态对象，
// 实例被多段/多实例共享会因 .test()/exec 的顺序依赖互相污染。
const chapterRegexpCache = new Map<string, Array<{ source: string; flags: string }>>();

export const buildChapterRegexps = (language: string, extraPatterns?: string[]): RegExp[] => {
  // 分隔符必须用 '\n'：join('') 会让 ['ab','c'] 与 ['a','bc'] 塌缩成同一个键，
  // 第二次 build 命中缓存拿到第一份规则集。patterns 由 parseChapterPatterns 按
  // 行切分而来、正则源不含换行，'\n' 作分隔符无碰撞面。
  const cacheKey = `${language}${extraPatterns?.join('\n') ?? ''}`;
  const cached = chapterRegexpCache.get(cacheKey);
  if (cached) {
    chapterRegexpCache.delete(cacheKey);
    chapterRegexpCache.set(cacheKey, cached);
    return cached.map(({ source, flags }) => new RegExp(source, flags));
  }
  const specs: Array<{ source: string; flags: string }> = [];

  // ③ 用户自定义章节正则（方向③）：每项匹配"标题行内容"，自动补行首锚点，
  // 置于最前优先匹配；new RegExp 抛错（非法规则）或 validateChapterPattern
  // 判为 ReDoS 病态（灾难性回溯）时安全忽略，不影响内置规则。
  for (const pattern of extraPatterns ?? []) {
    if (!pattern) continue;
    if (validateChapterPattern(pattern).length > 0) continue;
    try {
      new RegExp(String.raw`(?:^|\n)\s*(${pattern})`, 'u');
      specs.push({ source: String.raw`(?:^|\n)\s*(${pattern})`, flags: 'u' });
    } catch {
      // 非法用户规则忽略
    }
  }

  // ② 语言规则表（方向②）：zh/ja/ko/en 各有专门规则，其余语言回退到通用规则。
  const rules = CHAPTER_RULES[language] ?? CHAPTER_RULES['*'] ?? [];
  for (const { source, flags } of rules) {
    specs.push({ source, flags });
  }

  if (chapterRegexpCache.size >= CHAPTER_REGEXP_CACHE_MAX) {
    chapterRegexpCache.delete(chapterRegexpCache.keys().next().value!);
  }
  chapterRegexpCache.set(cacheKey, specs);
  return specs.map(({ source, flags }) => new RegExp(source, flags));
};

/** 单行文本版匹配：把 split 导向的 `(?:^|\n)` 前缀换成行首 `^`，去掉 g 标志，
 *  对 trim 后的整段元素文本执行；命中返回捕获的标题（m[1] ?? m[0]），未命中返回 null。 */
export const matchChapterTitle = (text: string, regexps: RegExp[]): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const rx of regexps) {
    const lineRx = new RegExp(rx.source.replace('(?:^|\\n)', '^'), rx.flags.replace('g', ''));
    const m = lineRx.exec(trimmed);
    if (m) return (m[1] ?? m[0]).trim();
  }
  return null;
};

// ---------------------------------------------------------------------------
// 数字噪声判定（仅供虚拟目录扫描的**内置规则**路径使用）。
//
// zh 第二条规则把「中文序数词行」与「纯数字行」打包在同一个 alternation 里
// （见上方 ZH 规则表的注释）：把它拆成独立规则条目会让 TXT 侧「两条
// alternative 共同贡献分章点」的书改变结果（拆开后数字行会提前胜出），违反
// 「TXT 行为逐字节不变」的约束。因此噪声过滤放在扫描侧后置做，引擎不动。
//
// 只认「纯数字 / 分隔符 / 日期单位」，不含任何实义字符：
//   - `2024-09-01`、`2025-06-16`、`123`、`2025`、`2024年9月1日` 命中（噪声）；
//   - `一、开端` 不命中（`一` 不是 `\d`，`、` 不在字符类）——中文序数词行是
//     正当的散文集章节形态，不能误杀；
//   - 用户手写正则时**不调用**本判定（日记体按日期分章是用户主权）。
export const isNumericNoiseLabel = (label: string): boolean =>
  /^[\d\s.\-–—/:·年月日]+$/.test(label);
