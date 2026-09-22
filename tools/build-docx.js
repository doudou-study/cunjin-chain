/* =====================================================================================
   Markdown → Word（.docx）导出
   -------------------------------------------------------------------------------------
   复用 thesis-creator 插件的 document_exporter.docx_writer：
     · 自动生成 Word 多级编号（Markdown 里的「1.1」前缀会被剥掉，交给 Word 编号）
     · 自动插入目录域（在「摘要」之后）
     · 标题用 Heading 样式，导航窗格 / 折叠 / 大纲视图都正常
     · 图片自动缩放（默认 12cm 宽），`![图 x-y 说明](路径)` 的方括号文字会变成图注
   注意：图片路径按 Markdown 文件所在目录解析，所以写相对路径即可（如 figs/er.png）。

     node tools/build-docx.js                     # 导出 docs/ 下全部 .md
     node tools/build-docx.js 论文                # 只导出文件名含「论文」的
   ===================================================================================== */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PY = 'C:\\Users\\admin\\.workbuddy\\skills\\thesis-creator\\.venv\\Scripts\\python.exe';
const SKILL_SCRIPTS = 'C:\\Users\\admin\\.workbuddy\\skills\\thesis-creator\\scripts';
const DOCS = path.join(__dirname, '..', 'docs');
const KEY = process.argv[2] || '';

if (!fs.existsSync(PY)) {
  console.error('找不到 thesis-creator 的 python 环境：' + PY);
  console.error('请确认插件已安装（~/.workbuddy/skills/thesis-creator/.venv）');
  process.exit(1);
}
if (!fs.existsSync(DOCS)) { console.error('缺少目录：' + DOCS); process.exit(1); }

const targets = fs.readdirSync(DOCS)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
  .filter((f) => !KEY || f.includes(KEY));

if (!targets.length) { console.error('没有匹配的 Markdown（关键词：' + (KEY || '全部') + '）'); process.exit(1); }

const runner = `
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, r'${SKILL_SCRIPTS}')
from document_exporter import docx_writer
import json
jobs = json.loads(sys.argv[1])
bad = 0
for src, dst in jobs:
    print('=' * 60)
    ok, msg = docx_writer.convert_md_to_docx(src, dst)
    if not ok:
        print('[失败] ' + str(msg)); bad += 1
sys.exit(1 if bad else 0)
`;

const jobs = targets.map((f) => [
  path.join(DOCS, f),
  path.join(DOCS, f.replace(/\.md$/, '.docx')),
]);

console.log(`准备导出 ${jobs.length} 个文档：`);
jobs.forEach(([s, d]) => console.log('  ' + path.basename(s) + '  →  ' + path.basename(d)));
console.log('');

try {
  const out = execFileSync(PY, ['-c', runner, JSON.stringify(jobs)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(out);
  console.log('\n全部导出完成。');
} catch (e) {
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  console.error('\n导出过程中有失败项，请看上面的输出。');
  process.exit(1);
}
