import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOW_REQUEST_MS, useSlowRequest } from './useSlowRequest.js';

/**
 * The threshold behind the "waking the free-tier API" message.
 *
 * The tests that matter are the negative ones. It is easy to write a hook that
 * shows the message - the requirement is that it shows it *only* when the wait
 * is genuinely abnormal, because an explanation attached to every fast load is
 * noise that trains people to ignore the one time it means something.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSlowRequest', () => {
  it('is false immediately, so a fast load shows nothing extra', () => {
    const { result } = renderHook(() => useSlowRequest(true));
    expect(result.current).toBe(false);
  });

  it('stays false right up to the threshold', () => {
    const { result } = renderHook(() => useSlowRequest(true));

    act(() => {
      vi.advanceTimersByTime(SLOW_REQUEST_MS - 1);
    });

    expect(result.current).toBe(false);
  });

  it('becomes true once the wait is abnormal', () => {
    const { result } = renderHook(() => useSlowRequest(true));

    act(() => {
      vi.advanceTimersByTime(SLOW_REQUEST_MS);
    });

    expect(result.current).toBe(true);
  });

  it('never fires for a request that finished before the threshold', () => {
    // The common case by a wide margin: a warm API answers in milliseconds.
    const { result, rerender } = renderHook(({ loading }) => useSlowRequest(loading), {
      initialProps: { loading: true },
    });

    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(SLOW_REQUEST_MS * 2);
    });

    expect(result.current).toBe(false);
  });

  it('resets when loading stops, so a later reload starts fresh', () => {
    // Without the reset, one slow cold start would leave the message showing on
    // every subsequent reload for the life of the component - which is exactly
    // the permanent label this hook exists to avoid.
    const { result, rerender } = renderHook(({ loading }) => useSlowRequest(loading), {
      initialProps: { loading: true },
    });

    act(() => {
      vi.advanceTimersByTime(SLOW_REQUEST_MS);
    });
    expect(result.current).toBe(true);

    rerender({ loading: false });
    expect(result.current).toBe(false);

    rerender({ loading: true });
    expect(result.current).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    const { result } = renderHook(() => useSlowRequest(true, 100));

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current).toBe(true);
  });
});
