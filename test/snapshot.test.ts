import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCard, defineSource, RelayController } from '../src/index';
import type { RelayCard, SourceCard } from '../src/index';
import { mockSource } from '../src/testing';

const A = 'svc.a';
const B = 'svc.b';

/** A 卡片:执行时机作为"请求中途治理动作"的触发器 */
function makeACard(): SourceCard {
  return defineSource({
    meta: { name: A, version: '1.0.0' },
    ref: 'svc/a',
    input: z.object({ n: z.number() }),
    upstreamRes: z.object({ v: z.number() }),
    output: z.object({ v: z.number() }),
    take: ({ n }) => ({ method: 'GET' as const, path: '/a', query: { n } }),
    put: (raw) => raw,
  });
}

/** 同名同 ref 的 B 卡片:以 put 标记区分版本(v + marker) */
function makeBCard(version: string, marker: number): SourceCard {
  return defineSource({
    meta: { name: B, version },
    ref: 'svc/b',
    input: z.object({ n: z.number() }),
    upstreamRes: z.object({ v: z.number() }),
    output: z.object({ v: z.number() }),
    take: ({ n }) => ({ method: 'GET' as const, path: '/b', query: { n } }),
    put: (raw) => ({ v: raw.v + marker }),
  });
}

function makeCard(): RelayCard {
  return defineCard({
    meta: { name: 'snap.exec', version: '1.0.0' },
    in: z.object({}),
    out: z.object({ b: z.number() }),
    uses: [A, B],
    collect: async (ctx) => {
      await ctx.invoke(A, { n: 1 });
      await ctx.invoke(B, { n: 2 });
    },
    respond: (ctx) => ({ b: (ctx.ir[B] as { v: number }).v }),
  });
}

describe('请求级源站快照(热升级/卸载只影响新请求)', () => {
  it('请求内热升级:in-flight 解析同一代际,新请求才见新版', async () => {
    const controller = new RelayController();
    const b1 = makeBCard('1.0.0', 0);
    const b2 = makeBCard('2.0.0', 100);
    let upgraded = false;
    const srcA = mockSource('svc/a', () => {
      if (!upgraded) {
        upgraded = true;
        controller.registerSourceCard(b2); // A 的响应期间完成 B 的热升级
      }
      return { body: { v: 1 } };
    });
    const srcB = mockSource('svc/b', { body: { v: 5 } });
    controller.registerSource(srcA.ref, srcA.binding);
    controller.registerSource(srcB.ref, srcB.binding);
    controller.registerSourceCard(makeACard());
    controller.registerSourceCard(b1);
    controller.registerCard(makeCard());
    const relay = controller.buildRelay();

    // 请求 1:A 执行期间 B 升级 → 本请求内 B 仍为 v1(marker 0)
    await expect(relay.handle('snap.exec', {})).resolves.toEqual({ b: 5 });
    expect(controller.listSourceCards().find((s) => s.name === B)?.version).toBe('2.0.0');

    // 请求 2:新快照 → B v2(marker 100)
    await expect(relay.handle('snap.exec', {})).resolves.toEqual({ b: 105 });
  });

  it('请求内卸载源站卡片:in-flight 仍可解析(快照),新请求即 SOURCE_NOT_REGISTERED', async () => {
    const controller = new RelayController();
    let deregistered = false;
    const srcA = mockSource('svc/a', () => {
      if (!deregistered) {
        deregistered = true;
        controller.deregisterSourceCard(B); // A 的响应期间卸载 B
      }
      return { body: { v: 1 } };
    });
    const srcB = mockSource('svc/b', { body: { v: 5 } });
    controller.registerSource(srcA.ref, srcA.binding);
    controller.registerSource(srcB.ref, srcB.binding);
    controller.registerSourceCard(makeACard());
    controller.registerSourceCard(makeBCard('1.0.0', 0));
    controller.registerCard(makeCard());
    const relay = controller.buildRelay();

    // 请求 1:快照内 B 仍可用 → 正常返回
    await expect(relay.handle('snap.exec', {})).resolves.toEqual({ b: 5 });

    // 请求 2:新快照不含已卸载的 B
    await expect(relay.handle('snap.exec', {})).rejects.toMatchObject({
      code: 'GLUE.CARD.SOURCE_NOT_REGISTERED',
      sourceId: B,
    });
  });
});
