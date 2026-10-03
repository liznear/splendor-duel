// compare.ts 的 Worker 入口: 每线程按主线程派发的局号跑一局, 结果 postMessage 返回.
// 入口在 compare.ts (import.meta.main 时才跑主流程), 本文件被其加载不会触发主流程.
import { cfgFromArgs, runGame } from './compare.ts';

self.onmessage = async (e: MessageEvent) => {
  const { i, argv } = e.data as { i: number; argv: string[] };
  self.postMessage(await runGame(i, cfgFromArgs(argv)));
};
