/* 部署后的正向核对。推上去不等于玩得到。

   为什么从 YAML 里搬出来：它之前是 workflow 里的一段 grep 循环，离线触发不了，
   所以它从没被观察到红过,而一条从没红过的断言和一条空断言在面板上长得
   一模一样：全绿。抽成纯函数之后，快闸门能拿两个必然失败的样本逐轮验它。

   **为什么要两个锥子而不是一个**：一个 404 页里恰巧包含某个常见字串的概率不低，
   单一 grep 会被它悄悄放过。两个锥子分属不同层：一个是脚本入口（证明代码真的
   部署上去了），一个是 canvas 的 id（证明页面骨架在）。

   锥子字符串与 index.html 是一组耦合参数：正向样本用的就是仓里真实的 index.html，
   所以改 canvas 的 id 或改脚本路径，快闸门会红。 */

export const ANCHORS = [
  { id: 'script-entry', needle: 'src/main.mjs', why: '游戏代码的入口没部署上去' },
  { id: 'canvas-id', needle: 'id="stage"', why: '页面骨架不对， canvas 不在' }
];

export function checkPageHtml(html) {
  const text = String(html == null ? '' : html);
  const missing = ANCHORS.filter(a => !text.includes(a.needle));
  return {
    ok: missing.length === 0 && text.length > 0,
    bytes: text.length,
    missing: missing.map(a => a.id),
    detail: missing.map(a => a.id + '（' + a.why + '）').join('、')
  };
}

const RETRIES = 8;
const DELAY_MS = 15000;

async function main(url) {
  if (!url) {
    process.stderr.write('没拿到 URL，这不是部署成功
');
    process.exit(1);
  }
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    let html = '';
    try {
      const res = await fetch(url, { redirect: 'follow' });
      html = res.ok ? await res.text() : '';
    } catch (err) {
      html = '';
    }
    const result = checkPageHtml(html);
    if (result.ok) {
      process.stdout.write('第 ' + attempt + ' 次验到了：' + url + '（' + result.bytes + 'B，两个锥子都在）
');
      process.exit(0);
    }
    process.stdout.write('第 ' + attempt + ' 次还不行：' + result.bytes + 'B，缺 ' + (result.detail || '整个页面都没读到') + '
');
    if (attempt < RETRIES) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  process.stderr.write('试了 ' + RETRIES + ' 次都没从 ' + url + ' 读到试玩页（这不是部署成功）
');
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('pages-check.mjs')) {
  await main(process.argv[2]);
}
