// Tests de comportamiento del descarte persistente del aviso de cambio contable.
import { test } from 'node:test'
import assert from 'node:assert'
import { bannerStorageKey, isBannerDismissed, dismissBanner, type KVStore } from '../../src/utils/bannerDismissal.ts'

function fakeStore(): KVStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) } }
}

test('key es por-negocio (aislada entre negocios)', () => {
  assert.strictEqual(bannerStorageKey('p', 'biz-A'), 'p:biz-A')
  assert.notStrictEqual(bannerStorageKey('p', 'biz-A'), bannerStorageKey('p', 'biz-B'))
  assert.strictEqual(bannerStorageKey('p', null), 'p:default')
})

test('no descartado por defecto; descartar persiste', () => {
  const s = fakeStore()
  const key = bannerStorageKey('p', 'biz-1')
  assert.strictEqual(isBannerDismissed(s, key), false)
  dismissBanner(s, key)
  assert.strictEqual(isBannerDismissed(s, key), true)
})

test('descartar un negocio no afecta a otro', () => {
  const s = fakeStore()
  dismissBanner(s, bannerStorageKey('p', 'biz-1'))
  assert.strictEqual(isBannerDismissed(s, bannerStorageKey('p', 'biz-1')), true)
  assert.strictEqual(isBannerDismissed(s, bannerStorageKey('p', 'biz-2')), false)
})

test('almacenamiento ausente/erróneo no rompe (fail-safe)', () => {
  const broken: KVStore = { getItem: () => { throw new Error('no storage') }, setItem: () => { throw new Error('no storage') } }
  assert.strictEqual(isBannerDismissed(broken, 'k'), false)
  assert.doesNotThrow(() => dismissBanner(broken, 'k'))
  assert.strictEqual(isBannerDismissed(undefined, 'k'), false)
})
