// 兼容垫片：本机 Node 20 缺少 undici@8 依赖的 markAsUncloneable（Node 22+ 内置在
// node:worker_threads 与 node:util 上）。通过 NODE_OPTIONS=--import 在 vite/qwik 加载 undici 之前补齐。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

for (const moduleId of ['node:worker_threads', 'node:util']) {
  const nodeModule = require(moduleId);
  if (typeof nodeModule.markAsUncloneable !== 'function') {
    nodeModule.markAsUncloneable = function markAsUncloneable() {
      // 开发环境无需真正标记不可克隆，空实现即可。
    };
  }
}
