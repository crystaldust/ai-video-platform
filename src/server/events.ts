// 事件总线：后台任务的进度 → 订阅了这个项目的 SSE 连接。只在内存里，服务重启就没了；
// 页面靠重新拉 overview 拿当前状态（运行记录都在库里），事件只用来提示「有变化了」和显示实时细节。
import type { ServerResponse } from 'node:http';

export interface ServerEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

const HEARTBEAT_MS = 15_000;

export class EventBus {
  private readonly subs = new Map<string, Set<ServerResponse>>();

  publish(projectId: string, event: ServerEvent): void {
    const text = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subs.get(projectId) ?? []) res.write(text);
  }

  /** 把这个响应变成 SSE 流，挂到项目上；连接断开自动退订。 */
  subscribe(projectId: string, res: ServerResponse, hello: ServerEvent): void {
    // 客户端在挂上之前就断了：close 事件已经过去，再挂会泄漏心跳定时器
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: ${hello.type}\ndata: ${JSON.stringify(hello)}\n\n`);
    const set = this.subs.get(projectId) ?? new Set<ServerResponse>();
    set.add(res);
    this.subs.set(projectId, set);
    // 注释行当心跳，免得中间层把空闲连接断掉
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(beat);
      set.delete(res);
      if (!set.size) this.subs.delete(projectId);
    });
  }

  subscribers(projectId: string): number {
    return this.subs.get(projectId)?.size ?? 0;
  }

  closeAll(): void {
    for (const set of this.subs.values()) for (const res of set) res.end();
    this.subs.clear();
  }
}
