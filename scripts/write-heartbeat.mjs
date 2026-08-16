/* 盖戳。三个设计点，每一个都有断言在守（见 AGENTS.md）：
   - always() 执行：闸门红也要盖戳。心跳回答的是「这条链还活着吗」，不是「产品对不对」。
   - 防自触发靠结构：这一步只在 schedule 或显式手动请求时执行，它推出去的提交触发的是
     普通 push，那一次永远不写。循环由构造终止，不依赖提交信息里的任何字符串。
   - 手动那条路写的是**另一个字段**：新鲜度只读 last_scheduled_run，一次手动盖戳不得
     救活一条已经死掉的 cron。 */
import fs from 'node:fs';

const FILE = 'heartbeat.json';
const hb = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const now = new Date().toISOString();
const event = process.env.EVENT || 'unknown';

if (event === 'schedule') hb.last_scheduled_run = now;
else hb.last_manual_run = now;

hb.last_event = event;
hb.gate_result = process.env.GATE_RESULT || null;
hb.web_result = process.env.WEB_RESULT || null;
hb.runs = (Number(hb.runs) || 0) + 1;

fs.writeFileSync(FILE, JSON.stringify(hb, null, 2) + '\n');
process.stdout.write('心跳已盖戳：' + event + ' -> ' + now + '\n');
