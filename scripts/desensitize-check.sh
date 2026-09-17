#!/usr/bin/env bash
# 推送前脱敏检查（规则见仓库根 AGENTS.md「推送范围与脱敏」）。
#
# 扫描**本次推送会带出去的文本**，命中本机路径 / 个人信息 / 凭据特征就拦下 push。
# 挂载点：.husky/pre-push 的第一步（在 format:check 之前——它最便宜，也最该先失败）。
#
# 只扫新增行，不扫全树：历史里已经存在的泄漏（早期入库的报告里写过真实的用户目录）
# 改不动，拿它拦住今天的新推送没有意义。基线选法：有上游就 upstream..HEAD；没有上游
# 就与任意一个远端分支比；连远端都没有才退回扫全部跟踪文件。
#
# 机器/个人专有词表放 .desensitize-terms（已 gitignore、不入库）：一行一个词，按字面
# 匹配。书名、真名、设备名这类写不成通用规则的东西放那里。该文件本身若被 git 跟踪，
# 本脚本直接报错——那等于把词表连同它要保护的内容一起推出去。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

TERMS_FILE='.desensitize-terms'

# ---------------------------------------------------------------- 词表文件本身
if git ls-files --error-unmatch "$TERMS_FILE" >/dev/null 2>&1; then
  echo "${RED}[脱敏检查] ${TERMS_FILE} 正被 git 跟踪——它是本机词表，必须留在工作区。${OFF}"
  echo "  处理：git rm --cached ${TERMS_FILE}，并确认 .gitignore 里有它。"
  exit 1
fi

# ---------------------------------------------------------------- 扫描范围
base_ref=''
if git rev-parse --verify --quiet '@{upstream}' >/dev/null 2>&1; then
  base_ref='@{upstream}'
else
  # 新分支首次推送：拿一个真实的远端分支当基线（跳过 origin/HEAD 这种符号引用）
  base_ref=$(git for-each-ref --format='%(refname)' refs/remotes 2>/dev/null \
    | grep -v 'HEAD$' | head -1 || true)
fi

mode='diff'
if [ -n "$base_ref" ]; then
  range="${base_ref}..HEAD"
  scope="本次推送的改动（${range}）"
  mapfile -t files < <(git diff --name-only --diff-filter=ACMR "$range" -- . 2>/dev/null)
else
  mode='tree'
  scope='HEAD 的全部跟踪文件（这个仓库还没有任何远端基线）'
  mapfile -t files < <(git ls-files)
fi

if [ "${#files[@]}" -eq 0 ]; then
  echo "${GREEN}[脱敏检查]${OFF} 没有待推送的改动，跳过。"
  exit 0
fi

echo "${DIM}[脱敏检查] 范围：${scope}，共 ${#files[@]} 个文件${OFF}"

# ---------------------------------------------------------------- 通用特征
# 规则里不能出现具体用户名——否则脚本自己就成了泄漏源。
# 路径分量的字符类特意排除了占位符标记（< > % $ * ? …），这样
# `C:\Users\<用户名>\...`、`%USERPROFILE%\...` 这类说明文字不会被误报。
PATTERNS=(
  '[A-Za-z]:[\/]+Users[\/]+[^\/<>%$*?… 	"'"'"'`,;)]+'
  # 用户名段限定为"字母/数字开头 + 字母数字点划"：这样规则文本自身
  # （`'/Users/[^/...'` 里的 `[`）不会被自己命中，脚本不至于自我拦截。
  '/(Users|home)/[A-Za-z0-9][A-Za-z0-9._-]*'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}'
  'ghp_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'sk-[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
# 命中这些就不算问题（公共地址，写进文件里也无害）
ALLOW='@users[.]noreply[.]github[.]com|@github[.]com|@example[.](com|org)|@noreply'

# 二进制/成品文件不扫（它们本来就该留在工作区，也读不出可读文本）
SKIP_CASE='*.png|*.jpg|*.jpeg|*.gif|*.webp|*.ico|*.pdf|*.epub|*.mobi|*.zip|*.gz|*.woff|*.woff2|*.ttf|*.otf|*.lock|*.snap'

# ---------------------------------------------------------------- 专有词表
terms=()
if [ -f "$TERMS_FILE" ]; then
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    terms+=("$line")
  done < "$TERMS_FILE"
fi

# ---------------------------------------------------------------- 逐个文件扫
hits=0
for f in "${files[@]}"; do
  case "$f" in $SKIP_CASE) continue ;; esac
  # 只取"新加进来的文本"：diff 模式取 + 行（去掉 +++ 头），无基线时取整个文件。
  if [ "$mode" = 'diff' ]; then
    text=$(git diff -U0 --diff-filter=ACMR "$range" -- "$f" 2>/dev/null \
      | sed -n 's/^+//p' | grep -v '^++' || true)
  else
    text=$(git show "HEAD:$f" 2>/dev/null || true)
  fi
  [ -n "$text" ] || continue

  for pat in "${PATTERNS[@]}"; do
    matches=$(printf '%s\n' "$text" | grep -nE "$pat" 2>/dev/null | grep -Ev "$ALLOW" || true)
    [ -n "$matches" ] || continue
    while IFS= read -r m; do
      echo "${RED}✗${OFF} ${f}${DIM}(新增行第 ${m%%:*} 行)${OFF} 命中 ${YELLOW}${pat}${OFF}"
      echo "      ${DIM}$(printf '%s' "${m#*:}" | cut -c1-120)${OFF}"
      hits=$((hits + 1))
    done <<< "$matches"
  done

  for term in "${terms[@]}"; do
    matches=$(printf '%s\n' "$text" | grep -nF -- "$term" 2>/dev/null || true)
    [ -n "$matches" ] || continue
    while IFS= read -r m; do
      echo "${RED}✗${OFF} ${f}${DIM}(新增行第 ${m%%:*} 行)${OFF} 命中专有词 ${YELLOW}${term}${OFF}"
      echo "      ${DIM}$(printf '%s' "${m#*:}" | cut -c1-120)${OFF}"
      hits=$((hits + 1))
    done <<< "$matches"
  done
done

# ---------------------------------------------------------------- 结论
if [ "$hits" -gt 0 ]; then
  echo
  echo "${RED}[脱敏检查] 发现 ${hits} 处需要处理的内容，已拦下本次推送。${OFF}"
  cat <<'TIP'
  怎么处理：
    1. 本机路径换成占位符（<用户目录>、%USERPROFILE%、$HOME）或相对路径；
    2. 真名 / 邮箱 / 设备名 / 书名等个人内容换成「样本 A」「某本书」这类代称；
    3. 整份属于本地文档（报告、计划、验收样本）就让它留在工作区——它在
       .gitignore 里，本来就不该入库；确需入库时先按上面两条脱敏；
    4. 确实无害却被通用规则误伤（例如提到某个公共邮箱），把该特征加进本脚本的
       ALLOW，或把希望提醒自己的整词写进 .desensitize-terms。
TIP
  exit 1
fi

echo "${GREEN}[脱敏检查] 通过：本次推送的改动里没有发现本机路径 / 个人信息 / 凭据特征。${OFF}"
