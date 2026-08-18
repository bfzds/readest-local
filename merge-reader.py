#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""merge-reader.py - 自动按章节顺序合并一个目录下的多个 txt 为全本
交互运行: python merge-reader.py          (循环菜单, 含[3]更换目标目录)
脚本运行: python merge-reader.py --dir <目录> [--mode A|C] [--out <输出文件>]
"""
import os, re, sys
from datetime import datetime

TITLE = "布洛妮娅大冒险"
CN = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}

def parse_chinese_num(s):
    total = 0; section = 0
    for ch in str(s):
        if ch == '十':
            section = section or 1
            total += section * 10
            section = 0
        elif ch in CN:
            section = section * 10 + CN[ch]
    return total + section

def parse_file(name):
    m = re.search(r'第\s*([一二三四五六七八九十百零两\d]+)\s*章', name)
    num = None
    if m:
        raw = re.sub(r'\s', '', m.group(1))
        num = int(raw) if raw.isdigit() else parse_chinese_num(raw)
    return num, ('炫彩' in name)

def build_order(dirpath, mode):
    files = [f for f in os.listdir(dirpath)
             if f.lower().endswith('.txt') and '全本' not in f]
    parsed = [dict(file=f, num=parse_file(f)[0], is_xc=parse_file(f)[1],
                   full=os.path.join(dirpath, f)) for f in files]
    numbered   = [x for x in parsed if x['num'] is not None]
    unnumbered = [x for x in parsed if x['num'] is None]
    if mode == 'C':
        zhen = sorted([x for x in numbered if not x['is_xc']], key=lambda x: x['num'])
        xc   = sorted([x for x in numbered if     x['is_xc']], key=lambda x: x['num'])
        order = zhen + xc
    else:
        order = sorted(numbered, key=lambda x: (x['num'], 1 if x['is_xc'] else 0))
    order.extend(unnumbered)
    return order

def title_of(name):
    return re.sub(r'\s+', ' ', re.sub(r'\.txt$', '', name, flags=re.I)).strip()

def clean_text(s):
    s = re.sub(r'^[\s\u3000]+', '', s)
    s = re.sub(r'(\r?\n[\s\u3000]*){3,}', '\r\n\r\n', s)
    return re.sub(r'[\s\u3000]+$', '', s)

def merge(dirpath, mode, out):
    order = build_order(dirpath, mode)
    outabs = os.path.abspath(out)
    order = [x for x in order if x['file'] != os.path.basename(outabs)]  # 排除输出文件自身
    parts, report = [], []
    for it in order:
        with open(it['full'], 'r', encoding='utf-8') as f:
            content = clean_text(f.read())
        parts.append('\r\n\r\n========== ' + title_of(it['file']) + ' ==========\r\n\r\n')
        parts.append(content)
        chars = len(re.sub(r'\s', '', content))
        report.append((it['file'], '炫彩' if it['is_xc'] else '正章', chars))
    header = ('《' + TITLE + '》全本（自动合并）\r\n'
              + ('合并模式：C-正文+附录(正章在前,炫彩追加到末尾)' if mode == 'C'
                 else '合并模式：A-完整合订·按章交错') + '\r\n'
              + '合并时间：' + datetime.now().strftime('%Y/%m/%d %H:%M:%S') + '\r\n'
              + '共 ' + str(len(order)) + ' 篇\r\n\r\n')
    total = sum(r[2] for r in report)
    with open(out, 'w', encoding='utf-8-sig') as f:
        f.write(header + ''.join(parts).strip() + '\r\n')
    return out, mode, total, report

def report(res):
    print('\n[完成] ' + res[0])
    print('模式: ' + res[1] + '   总字数(不含空白): ' + str(res[2]))
    print('--- 章节顺序 ---')
    for f, st, ch in res[3]:
        print('  [' + st + '] ' + f + '  ~' + str(ch) + '字')

def run_batch(args):
    def argof(flag):
        if flag in args:
            i = args.index(flag)
            if i + 1 < len(args):
                return args[i + 1]
        return None
    dirp = argof('--dir'); mode = (argof('--mode') or 'A').upper()
    out  = argof('--out')
    if not dirp:
        print('用法: python merge-reader.py --dir <目录> [--mode A|C] [--out <输出文件>]')
        print('      或直接运行交互向导: python merge-reader.py')
        sys.exit(1)
    if mode not in ('A', 'C'):
        mode = 'A'
    if not os.path.isdir(dirp):
        print('[错误] 目录不存在: ' + dirp); sys.exit(1)
    out = out or os.path.join(os.path.abspath(dirp), TITLE + '·全本.txt')
    report(merge(dirp, mode, out))

def interactive():
    print('\n' + '=' * 48)
    print('  《' + TITLE + '》 自动合并向导')
    print('=' * 48)
    work = os.getcwd()
    mode = 'A'
    out_override = None
    while True:
        ok = os.path.isdir(work)
        lst = build_order(work, mode) if ok else []
        n = len(lst)
        default_out = (os.path.join(work, TITLE + '·全本.txt') if ok else '')
        shown_out = out_override or default_out or '(未设置)'
        print('\n' + '-' * 48)
        print('当前设置:')
        print('  目标目录: ' + (work if ok else '[无效] ' + work))
        print('  合并模式: ' + ('A · 完整合订·按章交错' if mode == 'A' else 'C · 正文+附录'))
        print('  输出文件: ' + shown_out)
        if ok:
            print('  待合并 %d 个 txt（按章节排序）:' % n)
            for it in lst:
                print('     - [%s] %s' % ('炫彩' if it['is_xc'] else '正章', it['file']))
        print('-' * 48)
        print('请选择操作:')
        print('  [1] 切换合并模式 (A/C)')
        print('  [2] 设置输出文件名')
        print('  [3] 更换目标目录')
        print('  [4] 开始合并')
        print('  [0] 退出')
        c = input('  输入编号: ').strip()
        if c == '0':
            print('已退出。'); return
        elif c == '1':
            mode = 'C' if mode == 'A' else 'A'
            print('  -> 合并模式已切换为 ' + mode)
        elif c == '2':
            d = input('  输出文件名(回车恢复默认): ').strip()
            out_override = d if d else None
        elif c == '3':
            w = input('  目标目录: ').strip()
            if w:
                work = os.path.abspath(w)
                print('  -> 目标目录已设为: ' + work)
        elif c == '4':
            if not ok or n == 0:
                print('  [!] 目标目录无效或没有 txt，请先选 [3] 更换目标目录。')
                continue
            out = out_override or default_out
            if not out.lower().endswith('.txt'):
                print('  [!] 输出文件需为 .txt。请先选 [2] 设置。')
                continue
            ans = input('  确认开始合并？(y/N): ').strip().lower()
            if ans not in ('y', 'yes'):
                print('  已取消。'); continue
            report(merge(work, mode, out))
            input('  按回车返回菜单...')
        else:
            print('  无效输入。')

def main():
    if '--dir' in sys.argv:
        run_batch(sys.argv[1:])
    else:
        try:
            interactive()
        except (EOFError, KeyboardInterrupt):
            print('\n已取消。')
            sys.exit(0)

if __name__ == '__main__':
    main()
