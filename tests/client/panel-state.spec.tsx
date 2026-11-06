// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { usePolicyPanel } from '../../src/client/panel-state.ts'

afterEach(cleanup)
type Value = { revision: string; names: string[] }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const load = async (): Promise<Value> => ({ revision: 'r1', names: [] })
const toggle = (v: Value): Value => v

it('preserves repeated changes to the same switch in click order', async () => {
  const first = deferred<Value>()
  const bases: string[] = []
  const targets: string[][] = []
  const save = async (base: Value, next: Value): Promise<Value> => {
    bases.push(base.revision)
    targets.push(next.names)
    return bases.length === 1 ? first.promise : { ...next, revision: 'r3' }
  }
  const { result } = renderHook(() => usePolicyPanel({ load, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => {
    void result.current.commit(v => ({ ...v, names: ['A'] }))
    void result.current.commit(v => ({ ...v, names: [] }))
  })
  expect(result.current.value?.names).toEqual([])
  await act(async () => { first.resolve({ revision: 'r2', names: ['A'] }); await first.promise })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(bases).toEqual(['r1', 'r2'])
  expect(targets).toEqual([['A'], []])
  expect(result.current.value).toEqual({ revision: 'r3', names: [] })
})

it('ignores a stale read response arriving after a successful save', async () => {
  const staleRead = deferred<Value>()
  let reads = 0
  let disk: Value = { revision: 'r1', names: [] }
  const read = async (): Promise<Value> => ++reads === 2 ? staleRead.promise : disk
  const bases: string[] = []
  const save = async (base: Value, next: Value): Promise<Value> => {
    bases.push(base.revision)
    disk = { ...next, revision: `r${bases.length + 1}` }
    return disk
  }
  const { result } = renderHook(() => usePolicyPanel({ load: read, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => { void result.current.refresh() })
  await waitFor(() => expect(reads).toBe(2))
  await act(async () => { await result.current.commit(v => ({ ...v, names: ['A'] })) })
  await act(async () => {
    staleRead.resolve({ revision: 'r1', names: [] })
    await staleRead.promise
  })
  expect(result.current.value).toEqual({ revision: 'r2', names: ['A'] })
  await act(async () => { await result.current.commit(v => ({ ...v, names: [...v.names, 'B'] })) })
  expect(bases).toEqual(['r1', 'r2'])
  expect(result.current.value).toEqual({ revision: 'r3', names: ['A', 'B'] })
})

it('merges partial save responses into the submitted value before applying queued changes', async () => {
  const first = deferred<Value>()
  const bases: Value[] = []
  const save = async (base: Value): Promise<Value> => {
    bases.push(base)
    return bases.length === 1 ? first.promise : { revision: 'r3', names: [] }
  }
  const mergeSaved = (target: Value, saved: Value): Value => ({ ...target, revision: saved.revision })
  const { result } = renderHook(() => usePolicyPanel({ load, save, toggle, mergeSaved }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => {
    void result.current.commit(v => ({ ...v, names: ['A'] }))
    void result.current.commit(v => ({ ...v, names: [...v.names, 'B'] }))
  })
  await act(async () => { first.resolve({ revision: 'r2', names: [] }); await first.promise })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(bases).toEqual([{ revision: 'r1', names: [] }, { revision: 'r2', names: ['A'] }])
  expect(result.current.value).toEqual({ revision: 'r3', names: ['A', 'B'] })
})

it('saves queued operations against the last successful revision without losing optimistic changes', async () => {
  const first = deferred<Value>()
  const second = deferred<Value>()
  const bases: string[] = []
  const save = async (current: Value, next: Value): Promise<Value> => {
    bases.push(current.revision)
    if (bases.length === 1) return first.promise
    expect(next.names).toEqual(['A', 'B'])
    return second.promise
  }
  const { result } = renderHook(() => usePolicyPanel({ load, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => { void result.current.commit(v => ({ ...v, names: [...v.names, 'A'] })); void result.current.commit(v => ({ ...v, names: [...v.names, 'B'] })) })
  expect(result.current.value?.names).toEqual(['A', 'B'])
  await act(async () => { first.resolve({ revision: 'r2', names: ['A'] }); await first.promise })
  await waitFor(() => expect(bases).toEqual(['r1', 'r2']))
  expect(result.current.value?.names).toEqual(['A', 'B'])
  expect(result.current.busy).toBe(true)
  await act(async () => { second.resolve({ revision: 'r3', names: ['A', 'B'] }); await second.promise })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(result.current.value?.revision).toBe('r3')
})

it('defers a post-save refresh until queued saves finish', async () => {
  const first = deferred<Value>()
  const second = deferred<Value>()
  let reads = 0
  const read = async (): Promise<Value> => {
    reads++
    return reads === 1 ? { revision: 'r1', names: [] } : { revision: 'r3', names: ['A', 'B'] }
  }
  let writes = 0
  const save = async (): Promise<Value> => ++writes === 1 ? first.promise : second.promise
  const { result } = renderHook(() => usePolicyPanel({ load: read, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => {
    void result.current.commit(v => ({ ...v, names: ['A'] })).then(() => result.current.refresh())
    void result.current.commit(v => ({ ...v, names: [...v.names, 'B'] }))
  })
  await act(async () => { first.resolve({ revision: 'r2', names: ['A'] }); await first.promise })
  expect(writes).toBe(2)
  expect(reads).toBe(1)
  expect(result.current.value?.names).toEqual(['A', 'B'])
  await act(async () => { second.resolve({ revision: 'r3', names: ['A', 'B'] }); await second.promise })
  await waitFor(() => expect(reads).toBe(2))
  expect(result.current.value).toEqual({ revision: 'r3', names: ['A', 'B'] })
})

it('keeps a later save error visible when a successful operation requested refresh', async () => {
  const first = deferred<Value>()
  const second = deferred<Value>()
  let reads = 0
  const read = async (): Promise<Value> => { reads++; return { revision: 'r1', names: [] } }
  let writes = 0
  const save = async (): Promise<Value> => ++writes === 1 ? first.promise : second.promise
  const { result } = renderHook(() => usePolicyPanel({ load: read, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  act(() => {
    void result.current.commit(v => ({ ...v, names: ['A'] })).then(saved => { if (saved) return result.current.refresh() })
    void result.current.commit(v => ({ ...v, names: [...v.names, 'B'] }))
  })
  await act(async () => { first.resolve({ revision: 'r2', names: ['A'] }); await first.promise })
  await act(async () => { second.reject(new Error('stale-revision')); await second.promise.catch(() => {}) })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(result.current.error).toBe('stale-revision')
  expect(result.current.value).toEqual({ revision: 'r2', names: ['A'] })
  expect(reads).toBe(1)
})

it('cancels unsent operations after a failed save and rolls back to confirmed state', async () => {
  const first = deferred<Value>()
  let calls = 0
  const save = async (): Promise<Value> => { calls++; return first.promise }
  const { result } = renderHook(() => usePolicyPanel({ load, save, toggle }))
  await waitFor(() => expect(result.current.value).not.toBeNull())
  const outcomes: unknown[] = []
  act(() => {
    void result.current.commit(v => ({ ...v, names: ['A'] })).then(saved => outcomes.push(saved))
    void result.current.commit(v => ({ ...v, names: [...v.names, 'B'] })).then(saved => outcomes.push(saved))
  })
  await act(async () => { first.reject(new Error('stale-revision')); await first.promise.catch(() => {}) })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(calls).toBe(1)
  expect(outcomes).toEqual([false, false])
  expect(result.current.value).toEqual({ revision: 'r1', names: [] })
  expect(result.current.error).toBe('stale-revision')
})
